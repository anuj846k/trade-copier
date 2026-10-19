//+------------------------------------------------------------------+
//|                                          TradeCopierBridge.mq5   |
//|  Expert Advisor half of the Trade Copier bridge.                  |
//|                                                                  |
//|  It does exactly two things, both on a timer:                     |
//|    1. POST the account state, the symbol list, the position set,  |
//|       any results and any closed-trade events to the local agent, |
//|    2. execute the commands the agent hands back.                  |
//|                                                                  |
//|  The agent (a Node process on the same machine) forwards all of   |
//|  this to the cloud over a WebSocket. The EA never talks to the    |
//|  internet and holds no cloud credentials — only the shared secret |
//|  with the agent, which is a loopback-only defence-in-depth token. |
//|                                                                  |
//|  Compile in MetaEditor, then attach ONE instance per account to    |
//|  any chart. Allow WebRequest to the agent's host in              |
//|  Tools > Options > Expert Advisors before attaching.              |
//+------------------------------------------------------------------+
#property copyright   "Trade Copier"
#property version     "1.00"
#property description "Polls the local Trade Copier bridge agent and executes its commands."

#include "Json.mqh"

//+------------------------------------------------------------------+
//| Inputs                                                           |
//+------------------------------------------------------------------+
input group        "Bridge agent (must match agent.config.json)"
input string InpEaHost            = "127.0.0.1";  // Agent host (loopback)
input int    InpEaPort            = 8787;         // Agent port for this terminal
input string InpEaToken           = "";           // Shared secret with the agent
input int    InpPollIntervalMs    = 250;          // Poll interval (ms)

input group        "Reporting"
input bool   InpSendSymbols       = true;         // Send symbol metadata
input int    InpSymbolsEveryPolls = 40;           // ... of every N polls (0 = every poll)
input string InpSymbolWatchlist   = "";           // Extra symbols, comma separated
input bool   InpSendFullMarket    = false;        // false = Market Watch symbols only

input group        "Execution"
input int    InpDeviationPoints   = 30;           // Max slippage (points)
input bool   InpCloseOppositeSide = true;         // Close the opposite side before opening (netting)
input bool   InpDryRun            = false;        // Log commands but do not execute

//+------------------------------------------------------------------+
//| State                                                            |
//+------------------------------------------------------------------+
string g_results[];            // rendered JSON to send on the next poll
string g_events[];             // rendered JSON events, same lifecycle
long   g_lastTickets[];        // position tickets seen on the previous poll
int    g_poll = 0;
int    g_symbolsSentAt = 0;
string g_url = "";

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
string TcJoin(const string &items[])
  {
   string out = "";
   for(int i = 0; i < ArraySize(items); i++)
     {
      if(i > 0) out += ",";
      out += items[i];
     }
   return out;
  }

void TcPush(string &items[], const string value)
  {
   int n = ArraySize(items);
   ArrayResize(items, n + 1);
   items[n] = value;
  }

bool TcContains(const long &values[], const long needle)
  {
   for(int i = 0; i < ArraySize(values); i++)
      if(values[i] == needle) return true;
   return false;
  }

string TcSideOf(const long positionType)
  {
   return (positionType == POSITION_TYPE_BUY) ? "buy" : "sell";
  }

string TcPendingType(const long orderType)
  {
   switch(orderType)
     {
      case ORDER_TYPE_BUY_LIMIT:       return "buy_limit";
      case ORDER_TYPE_SELL_LIMIT:      return "sell_limit";
      case ORDER_TYPE_BUY_STOP:        return "buy_stop";
      case ORDER_TYPE_SELL_STOP:       return "sell_stop";
      case ORDER_TYPE_BUY_STOP_LIMIT:  return "buy_stop_limit";
      case ORDER_TYPE_SELL_STOP_LIMIT: return "sell_stop_limit";
     }
   return "buy_limit";
  }

long TcOrderTypeFor(const string pendingType)
  {
   if(pendingType == "sell_limit")      return ORDER_TYPE_SELL_LIMIT;
   if(pendingType == "buy_stop")        return ORDER_TYPE_BUY_STOP;
   if(pendingType == "sell_stop")       return ORDER_TYPE_SELL_STOP;
   if(pendingType == "buy_stop_limit")  return ORDER_TYPE_BUY_STOP_LIMIT;
   if(pendingType == "sell_stop_limit") return ORDER_TYPE_SELL_STOP_LIMIT;
   return ORDER_TYPE_BUY_LIMIT;
  }

//--- HT: the canonical key is cosmetic here; the server recomputes it from
//--- the raw broker name with the same rules used everywhere else.
string TcCanonical(const string name)
  {
   string upper = name;
   StringToUpper(upper);
   int cut = StringLen(upper);
   int dot = StringFind(upper, ".");
   int underscore = StringFind(upper, "_");
   if(dot > 0) cut = MathMin(cut, dot);
   if(underscore > 0) cut = MathMin(cut, underscore);
   return StringSubstr(upper, 0, cut);
  }

string TcAssetClass(const string canonical)
  {
   if(StringFind(canonical, "XAU") == 0 || StringFind(canonical, "XAG") == 0 ||
      StringFind(canonical, "XPT") == 0 || StringFind(canonical, "XPD") == 0)
      return "metal";
   if(canonical == "BTC" || canonical == "ETH" || canonical == "XRP" ||
      StringFind(canonical, "BTC") >= 0 || StringFind(canonical, "ETH") >= 0)
      return "crypto";
   if(StringFind(canonical, "USOIL") >= 0 || StringFind(canonical, "UKOIL") >= 0 ||
      StringFind(canonical, "NGAS") >= 0 || StringFind(canonical, "WTI") >= 0)
      return "energy";
   if(StringLen(canonical) == 6)
     {
      bool letters = true;
      for(int i = 0; i < 6; i++)
        {
         ushort c = StringGetCharacter(canonical, i);
         if(c < 'A' || c > 'Z') { letters = false; break; }
        }
      if(letters) return "forex";
     }
   return "unknown";
  }

string TcTradeMode(const string symbol)
  {
   long mode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   switch(mode)
     {
      case SYMBOL_TRADE_MODE_LONGONLY:  return "long_only";
      case SYMBOL_TRADE_MODE_SHORTONLY: return "short_only";
      case SYMBOL_TRADE_MODE_CLOSEONLY: return "close_only";
      case SYMBOL_TRADE_MODE_DISABLED:  return "disabled";
     }
   return "full";
  }

double TcPipSize(const string symbol, const int digits, const double point)
  {
   if(point <= 0) return 0.0001;
   //--- FX convention: 5-digit and 3-digit quotes price one pip as 10 points.
   if(digits == 5 || digits == 3) return point * 10.0;
   return point;
  }

ENUM_ORDER_TYPE_FILLING TcFilling(const string symbol)
  {
   long mode = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((mode & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((mode & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

int TcVolumeDigits(const double step)
  {
   if(step >= 1.0) return 0;
   if(step >= 0.1) return 1;
   return 2;
  }

//--- Floors to the broker's step and clamps to its bounds. Returns 0 when
//--- the requested volume is below the minimum, so the caller can report it
//--- instead of sending an order the broker will reject.
double TcNormalizeVolume(const string symbol, const double requested)
  {
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maximum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);

   double volume = MathFloor(requested / step + 0.0000001) * step;
   if(volume < minimum) return 0.0;
   if(maximum > 0 && volume > maximum) volume = maximum;
   return NormalizeDouble(volume, TcVolumeDigits(step));
  }

string TcNumberOrNull(const double value, const int digits)
  {
   if(value <= 0) return "null";
   return CJson::NumberFixed(value, digits);
  }

//--- The protocol carries slippage in pips (the unit of the copier), the
//--- terminal wants points. One conversion, in one place.
int TcDeviation(const string symbol, CJson *params)
  {
   double pips = params.GetNum("maxSlippagePips", 0);
   if(pips <= 0) return InpDeviationPoints;
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0) return InpDeviationPoints;
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   int points = (int)MathRound(pips * TcPipSize(symbol, digits, point) / point);
   return (points > 0) ? points : InpDeviationPoints;
  }

//--- ISO-8601 (what the server sends) to the terminal's own time format.
datetime TcParseIso(const string value)
  {
   string text = value;
   StringReplace(text, "T", " ");
   StringReplace(text, "Z", "");
   StringReplace(text, "-", ".");
   return StringToTime(text);
  }

//--- Maps an MT5 retcode onto the copier's error taxonomy. Unknown codes
//--- keep their numeric retcode in the error details.
string TcRetcode(const long retcode)
  {
   switch(retcode)
     {
      case TRADE_RETCODE_REQUOTE:            return "REQUOTE";
      case TRADE_RETCODE_REJECT:             return "BROKER_REJECTED";
      case TRADE_RETCODE_CANCEL:             return "BROKER_REJECTED";
      case TRADE_RETCODE_PLACED:             return "BROKER_REJECTED";
      case TRADE_RETCODE_PRICE_CHANGED:      return "PRICE_CHANGED";
      case TRADE_RETCODE_PRICE_OFF:          return "OFF_QUOTES";
      case TRADE_RETCODE_INVALID_VOLUME:     return "INVALID_VOLUME";
      case TRADE_RETCODE_INVALID_PRICE:      return "INVALID_PRICE";
      case TRADE_RETCODE_INVALID_STOPS:      return "INVALID_SLTP";
      case TRADE_RETCODE_TRADE_DISABLED:     return "TRADE_DISABLED";
      case TRADE_RETCODE_MARKET_CLOSED:      return "MARKET_CLOSED";
      case TRADE_RETCODE_NO_MONEY:           return "NO_MONEY";
      case TRADE_RETCODE_TOO_MANY_REQUESTS:  return "TOO_MANY_REQUESTS";
      case TRADE_RETCODE_LIMIT_ORDERS:       return "BROKER_REJECTED";
      case TRADE_RETCODE_LIMIT_VOLUME:       return "VOLUME_TOO_LARGE";
      case TRADE_RETCODE_POSITION_CLOSED:    return "TICKET_NOT_FOUND";
      case TRADE_RETCODE_ORDER_CHANGED:      return "ORDER_NOT_FOUND";
      case TRADE_RETCODE_TIMEOUT:            return "TIMEOUT";
      case TRADE_RETCODE_CONNECTION:         return "AGENT_OFFLINE";
      case TRADE_RETCODE_ONLY_REAL:          return "BROKER_REJECTED";
      case TRADE_RETCODE_LONG_ONLY:          return "BROKER_REJECTED";
      case TRADE_RETCODE_SHORT_ONLY:         return "BROKER_REJECTED";
      case TRADE_RETCODE_CLOSE_ONLY:         return "BROKER_REJECTED";
     }
   return "BROKER_REJECTED";
  }

//+------------------------------------------------------------------+
//| Reporting                                                        |
//+------------------------------------------------------------------+
string TcSnapshotJson(void)
  {
   double marginLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   int leverage = (int)AccountInfoInteger(ACCOUNT_LEVERAGE);
   return StringFormat("{\"balance\":%s,\"equity\":%s,\"margin\":%s,\"freeMargin\":%s,\"marginLevel\":%s,\"currency\":%s,\"leverage\":%d,\"at\":%s}",
                       CJson::NumberFixed(AccountInfoDouble(ACCOUNT_BALANCE), 2),
                       CJson::NumberFixed(AccountInfoDouble(ACCOUNT_EQUITY), 2),
                       CJson::NumberFixed(AccountInfoDouble(ACCOUNT_MARGIN), 2),
                       CJson::NumberFixed(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2),
                       (marginLevel > 0 ? CJson::NumberFixed(marginLevel, 2) : "null"),
                       CJson::Quote(AccountInfoString(ACCOUNT_CURRENCY)),
                       leverage,
                       CJson::Quote(TcIso8601(TimeGMT())));
  }

string TcSymbolJson(const string symbol)
  {
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double contractSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   string canonical = TcCanonical(symbol);
   double swapLong = SymbolInfoDouble(symbol, SYMBOL_SWAP_LONG);
   double swapShort = SymbolInfoDouble(symbol, SYMBOL_SWAP_SHORT);
   return StringFormat("{\"name\":%s,\"canonical\":%s,\"assetClass\":%s,\"digits\":%d,\"point\":%s,\"pipSize\":%s,\"contractSize\":%s,\"minLot\":%s,\"maxLot\":%s,\"lotStep\":%s,\"tradeMode\":%s,\"enabled\":%s,\"quoteCurrency\":%s,\"maxLotPerOrder\":%s,\"swapLong\":%s,\"swapShort\":%s,\"updatedAt\":%s}",
                       CJson::Quote(symbol),
                       CJson::Quote(canonical),
                       CJson::Quote(TcAssetClass(canonical)),
                       digits,
                       CJson::NumberFixed(point, digits + 2),
                       CJson::NumberFixed(TcPipSize(symbol, digits, point), digits + 2),
                       CJson::NumberFixed(contractSize, 2),
                       CJson::NumberFixed(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN), 2),
                       CJson::NumberFixed(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX), 2),
                       CJson::NumberFixed(SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), 2),
                       CJson::Quote(TcTradeMode(symbol)),
                       "true",
                       CJson::Quote(SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT)),
                       "null",
                       CJson::NumberFixed(swapLong, 4),
                       CJson::NumberFixed(swapShort, 4),
                       CJson::Quote(TcIso8601(TimeGMT())));
  }

string TcSymbolsJson(void)
  {
   string out = "[";
   bool first = true;

   //--- InpSendFullMarket=false reports the Market Watch only: symbol
   //--- properties are not guaranteed to be populated for symbols the terminal
   //--- has not downloaded, so "everything the broker lists" would be a lot of
   //--- zeroes. InpSymbolWatchlist adds instruments on demand.
   bool selectedOnly = !InpSendFullMarket;
   int total = SymbolsTotal(selectedOnly);
   for(int i = 0; i < total; i++)
     {
      string symbol = SymbolName(i, selectedOnly);
      if(symbol == "") continue;
      if(SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE) <= 0) continue;
      if(!first) out += ",";
      out += TcSymbolJson(symbol);
      first = false;
     }

   //--- extra instruments named by the operator, in case they are not in the
   //--- Market Watch yet; SymbolSelect adds them so their ticks start flowing.
   string watchlist[];
   int parts = StringSplit(InpSymbolWatchlist, ',', watchlist);
   for(int i = 0; i < parts; i++)
     {
      string symbol = watchlist[i];
      StringTrimLeft(symbol);
      StringTrimRight(symbol);
      if(symbol == "") continue;
      SymbolSelect(symbol, true);
      if(SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE) <= 0) continue;
      if(!first) out += ",";
      out += TcSymbolJson(symbol);
      first = false;
     }

   out += "]";
   g_symbolsSentAt = g_poll;
   return out;
  }

string TcPositionsJson(void)
  {
   string out = "[";
   bool first = true;

   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string symbol = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      double volume = PositionGetDouble(POSITION_VOLUME);
      if(volume <= 0) continue;
      double stopLoss = PositionGetDouble(POSITION_SL);
      double takeProfit = PositionGetDouble(POSITION_TP);
      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);

      if(!first) out += ",";
      out += StringFormat("{\"ticket\":%s,\"symbol\":%s,\"side\":%s,\"volume\":%s,\"closedVolume\":0,\"openPrice\":%s,\"currentPrice\":%s,\"stopLoss\":%s,\"takeProfit\":%s,\"kind\":\"market\",\"pendingType\":null,\"expiry\":null,\"magic\":%d,\"comment\":%s,\"openedAt\":%s,\"profit\":%s,\"swap\":%s,\"commission\":null}",
                          CJson::Quote(IntegerToString((long)ticket)),
                          CJson::Quote(symbol),
                          CJson::Quote(TcSideOf(PositionGetInteger(POSITION_TYPE))),
                          CJson::NumberFixed(volume, 2),
                          CJson::NumberFixed(PositionGetDouble(POSITION_PRICE_OPEN), digits),
                          (bid > 0 ? CJson::NumberFixed(bid, digits) : "null"),
                          TcNumberOrNull(stopLoss, digits),
                          TcNumberOrNull(takeProfit, digits),
                          (int)PositionGetInteger(POSITION_MAGIC),
                          CJson::Quote(PositionGetString(POSITION_COMMENT)),
                          CJson::Quote(TcIso8601((datetime)PositionGetInteger(POSITION_TIME))),
                          CJson::NumberFixed(PositionGetDouble(POSITION_PROFIT), 2),
                          CJson::NumberFixed(PositionGetDouble(POSITION_SWAP), 2));
      first = false;
     }

   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      string symbol = OrderGetString(ORDER_SYMBOL);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      double volume = OrderGetDouble(ORDER_VOLUME_CURRENT);
      if(volume <= 0) continue;

      if(!first) out += ",";
      out += StringFormat("{\"ticket\":%s,\"symbol\":%s,\"side\":%s,\"volume\":%s,\"closedVolume\":0,\"openPrice\":%s,\"currentPrice\":null,\"stopLoss\":%s,\"takeProfit\":%s,\"kind\":\"pending\",\"pendingType\":%s,\"expiry\":%s,\"magic\":%d,\"comment\":%s,\"openedAt\":%s,\"profit\":null,\"swap\":null,\"commission\":null}",
                          CJson::Quote(IntegerToString((long)ticket)),
                          CJson::Quote(symbol),
                          CJson::Quote(OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_BUY_LIMIT ||
                                       OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_BUY_STOP ||
                                       OrderGetInteger(ORDER_TYPE) == ORDER_TYPE_BUY_STOP_LIMIT ? "buy" : "sell"),
                          CJson::NumberFixed(volume, 2),
                          CJson::NumberFixed(OrderGetDouble(ORDER_PRICE_OPEN), digits),
                          TcNumberOrNull(OrderGetDouble(ORDER_SL), digits),
                          TcNumberOrNull(OrderGetDouble(ORDER_TP), digits),
                          CJson::Quote(TcPendingType(OrderGetInteger(ORDER_TYPE))),
                          (OrderGetInteger(ORDER_TYPE_TIME) == ORDER_TIME_SPECIFIED
                           ? CJson::Quote(TcIso8601((datetime)OrderGetInteger(ORDER_TIME_EXPIRATION)))
                           : "null"),
                          (int)OrderGetInteger(ORDER_MAGIC),
                          CJson::Quote(OrderGetString(ORDER_COMMENT)),
                          CJson::Quote(TcIso8601((datetime)OrderGetInteger(ORDER_TIME_SETUP))));
      first = false;
     }

   out += "]";
   return out;
  }

//+------------------------------------------------------------------+
//| Closed-trade events                                              |
//|                                                                  |
//| The position set is authoritative for opens/closes; these events  |
//| exist because realised P/L (profit, swap, commission) is only     |
//| available from history, and because the engine needs the entry    |
//| price to key the result back to its own copy.                     |
//+------------------------------------------------------------------+
void TcEmitClosedTrade(const long positionId)
  {
   if(!HistorySelectByPosition((ulong)positionId)) return;
   int total = HistoryDealsTotal();
   if(total == 0) return;

   double profit = 0.0, swap = 0.0, commission = 0.0;
   double openPrice = 0.0, closePrice = 0.0, closedVolume = 0.0;
   long openTime = 0, closeTime = 0;
   string symbol = "", comment = "";
   int magic = 0;
   bool isBuy = true;

   for(int i = 0; i < total; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      profit     += HistoryDealGetDouble(deal, DEAL_PROFIT);
      swap       += HistoryDealGetDouble(deal, DEAL_SWAP);
      commission += HistoryDealGetDouble(deal, DEAL_COMMISSION);

      if(entry == DEAL_ENTRY_IN)
        {
         openPrice = HistoryDealGetDouble(deal, DEAL_PRICE);
         openTime  = HistoryDealGetInteger(deal, DEAL_TIME);
         symbol    = HistoryDealGetString(deal, DEAL_SYMBOL);
         magic     = (int)HistoryDealGetInteger(deal, DEAL_MAGIC);
         comment   = HistoryDealGetString(deal, DEAL_COMMENT);
         isBuy     = (HistoryDealGetInteger(deal, DEAL_TYPE) == DEAL_TYPE_BUY);
        }
      else
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
           {
            closePrice   = HistoryDealGetDouble(deal, DEAL_PRICE);
            closeTime    = HistoryDealGetInteger(deal, DEAL_TIME);
            closedVolume += HistoryDealGetDouble(deal, DEAL_VOLUME);
           }
     }

   //--- An order that was merely cancelled leaves no OUT deal: not a closed trade.
   if(closeTime == 0 || symbol == "") return;

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string event = StringFormat("{\"kind\":\"trade_closed\",\"ticket\":%s,\"symbol\":%s,\"side\":%s,\"volume\":%s,\"closedVolume\":%s,\"price\":%s,\"openPrice\":%s,\"profit\":%s,\"swap\":%s,\"commission\":%s,\"magic\":%d,\"comment\":%s,\"at\":%s}",
                               CJson::Quote(IntegerToString(positionId)),
                               CJson::Quote(symbol),
                               CJson::Quote(isBuy ? "buy" : "sell"),
                               CJson::NumberFixed(closedVolume, 2),
                               CJson::NumberFixed(closedVolume, 2),
                               CJson::NumberFixed(closePrice, digits),
                               CJson::NumberFixed(openPrice, digits),
                               CJson::NumberFixed(profit, 2),
                               CJson::NumberFixed(swap, 2),
                               CJson::NumberFixed(commission, 2),
                               magic,
                               CJson::Quote(comment),
                               CJson::Quote(TcIso8601((datetime)closeTime)));
   TcPush(g_events, event);
  }

void TcHarvestClosures(void)
  {
   long current[];
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      int n = ArraySize(current);
      ArrayResize(current, n + 1);
      current[n] = (long)ticket;
     }

   for(int i = 0; i < ArraySize(g_lastTickets); i++)
     {
      long ticket = g_lastTickets[i];
      if(TcContains(current, ticket)) continue;
      TcEmitClosedTrade(ticket);
     }

   ArrayResize(g_lastTickets, ArraySize(current));
   ArrayCopy(g_lastTickets, current);
  }

//+------------------------------------------------------------------+
//| Transport                                                        |
//+------------------------------------------------------------------+
int TcPost(const string body, string &response)
  {
   char data[], result[];
   string headers = "Content-Type: application/json\r\n";
   string responseHeaders = "";

   StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   //--- StringToCharArray appends a terminating zero; do not send it.
   if(ArraySize(data) > 0) ArrayResize(data, ArraySize(data) - 1);

   ResetLastError();
   int status = WebRequest("POST", g_url, headers, 3000, data, result, responseHeaders);
   if(status == -1)
     {
      int error = GetLastError();
      PrintFormat("TradeCopier: WebRequest to %s failed (%d). Add the host to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.", g_url, error);
      return -1;
     }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return status;
  }

//+------------------------------------------------------------------+
//| Command execution                                                |
//+------------------------------------------------------------------+
string TcResultOk(const string requestId, const string dataJson)
  {
   return StringFormat("{\"requestId\":%s,\"ok\":true,\"data\":%s}", CJson::Quote(requestId), dataJson);
  }

string TcResultError(const string requestId, const string code, const string message, const long brokerCode)
  {
   return StringFormat("{\"requestId\":%s,\"ok\":false,\"error\":{\"code\":%s,\"message\":%s,\"brokerCode\":%d}}",
                       CJson::Quote(requestId), CJson::Quote(code), CJson::Quote(message), brokerCode);
  }

string TcFillData(const string ticket, const double volume, const double price, const int digits)
  {
   return StringFormat("{\"ticket\":%s,\"filledVolume\":%s,\"filledPrice\":%s}",
                       CJson::Quote(ticket), CJson::NumberFixed(volume, 2), CJson::NumberFixed(price, digits));
  }

string TcCloseData(const string ticket, const double closedVolume, const double closePrice, const bool fullyClosed, const int digits)
  {
   //--- Realised P/L is not returned here: MT5 does not know it until the deal
   //--- lands in history. The `trade_closed` event carries profit, swap and
   //--- commission, and that is what the engine attributes to the link.
   return StringFormat("{\"ticket\":%s,\"closedVolume\":%s,\"closePrice\":%s,\"profit\":0,\"fullyClosed\":%s,\"at\":%s}",
                       CJson::Quote(ticket),
                       CJson::NumberFixed(closedVolume, 2),
                       CJson::NumberFixed(closePrice, digits),
                       fullyClosed ? "true" : "false",
                       CJson::Quote(TcIso8601(TimeGMT())));
  }

//--- One round trip to the trade server. Fills `result` either way.
bool TcSend(MqlTradeRequest &request, MqlTradeResult &result)
  {
   ResetLastError();
   if(!OrderSend(request, result))
     {
      result.retcode = (uint)GetLastError();
      return false;
     }
   return (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED ||
           result.retcode == TRADE_RETCODE_DONE_PARTIAL);
  }

double TcExitPrice(const string symbol, const string side)
  {
   return (side == "buy") ? SymbolInfoDouble(symbol, SYMBOL_BID) : SymbolInfoDouble(symbol, SYMBOL_ASK);
  }

string TcExecuteOpen(const string requestId, CJson *params, const bool pending)
  {
   string symbol = params.GetStr("symbol");
   string side = params.GetStr("side", "buy");
   double volume = params.GetNum("volume", 0);
   double stopLoss = params.GetNum("stopLoss", 0);
   double takeProfit = params.GetNum("takeProfit", 0);

   if(symbol == "" || volume <= 0)
      return TcResultError(requestId, "VALIDATION", "open needs a symbol and a positive volume", 0);

   if(!SymbolSelect(symbol, true))
      return TcResultError(requestId, "UNKNOWN_SYMBOL", "The terminal does not know " + symbol, 0);

   double normalised = TcNormalizeVolume(symbol, volume);
   if(normalised <= 0)
      return TcResultError(requestId, "VOLUME_TOO_SMALL", StringFormat("Volume %s is below the minimum for %s", DoubleToString(volume, 4), symbol), 0);

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = pending ? TRADE_ACTION_PENDING : TRADE_ACTION_DEAL;
   request.symbol = symbol;
   request.volume = normalised;
   request.sl = NormalizeDouble(stopLoss, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   request.tp = NormalizeDouble(takeProfit, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   request.magic = (int)params.GetNum("magic", 0);
   request.comment = params.GetStr("comment", "copier");
   request.deviation = TcDeviation(symbol, params);
   request.type_filling = TcFilling(symbol);

   if(pending)
     {
      request.type = (ENUM_ORDER_TYPE)TcOrderTypeFor(params.GetStr("pendingType", "buy_limit"));
      request.price = NormalizeDouble(params.GetNum("price", 0), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
      string expiry = params.GetStr("expiry", "");
      if(expiry != "")
        {
         request.type_time = ORDER_TIME_SPECIFIED;
         request.expiration = TcParseIso(expiry);
        }
     }
   else
     {
      request.type = (side == "sell") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      request.price = NormalizeDouble(TcExitPrice(symbol, side), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
     }

   if(InpDryRun)
     {
      PrintFormat("TradeCopier dry run: %s %s %s %s", pending ? "pending" : "market", side, DoubleToString(normalised, 2), symbol);
      return TcResultOk(requestId, TcFillData("dry-run", normalised, request.price, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)));
     }

   bool ok = TcSend(request, result);
   if(!ok)
      return TcResultError(requestId, TcRetcode(result.retcode), result.comment, (long)result.retcode);

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double filledVolume = (result.volume > 0) ? result.volume : normalised;
   double filledPrice = (result.price > 0) ? result.price : request.price;
   return TcResultOk(requestId, TcFillData(IntegerToString((long)result.order), filledVolume, filledPrice, digits));
  }

string TcExecuteClose(const string requestId, CJson *params, const bool partial)
  {
   string ticketText = params.GetStr("ticket");
   if(ticketText == "")
      return TcResultError(requestId, "VALIDATION", "close needs a ticket", 0);

   long ticket = (long)StringToInteger(ticketText);
   string symbol = (PositionSelectByTicket((ulong)ticket)) ? PositionGetString(POSITION_SYMBOL) : "";
   if(symbol == "")
      return TcResultError(requestId, "TICKET_NOT_FOUND", "Position " + ticketText + " is not open", 0);

   double held = PositionGetDouble(POSITION_VOLUME);
   string side = TcSideOf(PositionGetInteger(POSITION_TYPE));
   double volume = partial ? params.GetNum("volume", 0) : held;
   if(volume <= 0 || volume > held + 0.0000001) volume = held;
   double normalised = TcNormalizeVolume(symbol, volume);
   if(normalised <= 0) normalised = held;

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_DEAL;
   request.position = (ulong)ticket;
   request.symbol = symbol;
   request.volume = normalised;
   //--- closing means taking the opposite side at the opposite price
   request.type = (side == "buy") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = NormalizeDouble(TcExitPrice(symbol, side), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   request.deviation = TcDeviation(symbol, params);
   request.magic = (int)params.GetNum("magic", 0);
   request.comment = "copy-close";
   request.type_filling = TcFilling(symbol);

   if(InpDryRun)
     {
      PrintFormat("TradeCopier dry run: close %s of %s (%s)", DoubleToString(normalised, 2), symbol, ticketText);
      return TcResultOk(requestId, TcCloseData(ticketText, normalised, request.price, normalised >= held, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS)));
     }

   bool ok = TcSend(request, result);
   if(!ok)
      return TcResultError(requestId, TcRetcode(result.retcode), result.comment, (long)result.retcode);

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double closedVolume = (result.volume > 0) ? result.volume : normalised;
   double closePrice = (result.price > 0) ? result.price : request.price;
   //--- a partial close leaves the position open, and the engine's own link
   //--- state has to reflect that
   bool fullyClosed = (closedVolume + 0.0000001) >= held;
   return TcResultOk(requestId, TcCloseData(ticketText, closedVolume, closePrice, fullyClosed, digits));
  }

string TcExecuteModify(const string requestId, CJson *params)
  {
   string ticketText = params.GetStr("ticket");
   long ticket = (long)StringToInteger(ticketText);
   if(ticketText == "" || !PositionSelectByTicket((ulong)ticket))
      return TcResultError(requestId, "TICKET_NOT_FOUND", "Position " + ticketText + " is not open", 0);

   string symbol = PositionGetString(POSITION_SYMBOL);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_SLTP;
   request.position = (ulong)ticket;
   request.symbol = symbol;
   request.sl = params.IsNull("stopLoss") ? PositionGetDouble(POSITION_SL) : NormalizeDouble(params.GetNum("stopLoss", 0), digits);
   request.tp = params.IsNull("takeProfit") ? PositionGetDouble(POSITION_TP) : NormalizeDouble(params.GetNum("takeProfit", 0), digits);

   if(InpDryRun)
      return TcResultOk(requestId, "{}");

   bool ok = TcSend(request, result);
   if(!ok)
      return TcResultError(requestId, TcRetcode(result.retcode), result.comment, (long)result.retcode);
   return TcResultOk(requestId, "{}");
  }

string TcExecuteCancel(const string requestId, CJson *params)
  {
   string ticketText = params.GetStr("ticket");
   if(ticketText == "")
      return TcResultError(requestId, "VALIDATION", "cancel needs a ticket", 0);

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_REMOVE;
   request.order = (ulong)StringToInteger(ticketText);

   if(InpDryRun)
      return TcResultOk(requestId, "{}");

   bool ok = TcSend(request, result);
   if(!ok)
      return TcResultError(requestId, TcRetcode(result.retcode), result.comment, (long)result.retcode);
   return TcResultOk(requestId, "{}");
  }

//--- True when this ticket should be closed: an explicit list wins, then the
//--- magic filter, then (with neither) everything.
bool TcWanted(CJson *tickets, const ulong ticket, const long filterMagic)
  {
   if(filterMagic >= 0 && (long)PositionGetInteger(POSITION_MAGIC) != filterMagic) return false;
   if(tickets == NULL || tickets.type != JSON_ARRAY || tickets.Count() == 0) return true;
   string text = IntegerToString((long)ticket);
   for(int i = 0; i < tickets.Count(); i++)
     {
      CJson *node = tickets.At(i);
      if(node == NULL) continue;
      if(node.type == JSON_STRING && node.sval == text) return true;
      if(node.type == JSON_NUMBER && (long)node.nval == (long)ticket) return true;
     }
   return false;
  }

string TcExecuteCloseAll(const string requestId, CJson *params)
  {
   long filterMagic = (long)params.GetNum("filterMagic", -1);
   CJson *tickets = params.Get("tickets");
   int closed = 0;
   int failed = 0;
   uint lastRetcode = 0;
   string lastMessage = "";

   //--- iterate downwards: closing a position shifts the ones after it
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!TcWanted(tickets, ticket, filterMagic)) continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      string side = TcSideOf(PositionGetInteger(POSITION_TYPE));
      double volume = PositionGetDouble(POSITION_VOLUME);
      if(volume <= 0) continue;

      if(InpDryRun)
        {
         closed++;
         continue;
        }

      MqlTradeRequest request;
      MqlTradeResult result;
      ZeroMemory(request);
      ZeroMemory(result);

      request.action = TRADE_ACTION_DEAL;
      request.position = ticket;
      request.symbol = symbol;
      request.volume = volume;
      request.type = (side == "buy") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      request.price = NormalizeDouble(TcExitPrice(symbol, side), (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
      request.deviation = (int)InpDeviationPoints;
      request.comment = "copy-close-all";
      request.type_filling = TcFilling(symbol);
      if(TcSend(request, result))
         closed++;
      else
        {
         failed++;
         lastRetcode = result.retcode;
         lastMessage = result.comment;
        }
     }

   if(failed > 0 && closed == 0)
      return TcResultError(requestId, TcRetcode(lastRetcode), lastMessage, (long)lastRetcode);

   return TcResultOk(requestId, StringFormat("{\"closed\":%d,\"failed\":%d}", closed, failed));
  }

void TcExecute(const string requestId, const string kind, CJson *params)
  {
   string result = "";

   if(params == NULL)
     {
      TcPush(g_results, TcResultError(requestId, "VALIDATION", "command has no params", 0));
      return;
     }

   if(kind == "open")                result = TcExecuteOpen(requestId, params, false);
   else if(kind == "place_pending")  result = TcExecuteOpen(requestId, params, true);
   else if(kind == "close")          result = TcExecuteClose(requestId, params, false);
   else if(kind == "close_partial")  result = TcExecuteClose(requestId, params, true);
   else if(kind == "modify")         result = TcExecuteModify(requestId, params);
   else if(kind == "cancel_pending") result = TcExecuteCancel(requestId, params);
   else if(kind == "close_all")      result = TcExecuteCloseAll(requestId, params);
   else result = TcResultError(requestId, "NOT_IMPLEMENTED", "Unknown command kind " + kind, 0);

   TcPush(g_results, result);
  }

void TcHandleResponse(const string response)
  {
   CJsonParser parser;
   CJson *root = parser.Parse(response);
   if(root == NULL || root.type != JSON_OBJECT)
     {
      if(root != NULL) delete root;
      PrintFormat("TradeCopier: could not parse the agent response: %s", StringSubstr(response, 0, 200));
      return;
     }

   CJson *commands = root.Get("commands");
   if(commands != NULL && commands.type == JSON_ARRAY)
     {
      for(int i = 0; i < commands.Count(); i++)
        {
         CJson *command = commands.At(i);
         if(command == NULL || command.type != JSON_OBJECT) continue;
         string requestId = command.GetStr("requestId");
         string kind = command.GetStr("kind");
         if(requestId == "" || kind == "") continue;
         if(InpDryRun) PrintFormat("TradeCopier: command %s %s", kind, requestId);
         TcExecute(requestId, kind, command.Get("params"));
        }
     }

   delete root;
  }

//+------------------------------------------------------------------+
//| Poll cycle                                                       |
//+------------------------------------------------------------------+
void TcPoll(void)
  {
   if(InpEaToken == "")
     {
      Print("TradeCopier: InpEaToken is empty — set it to the agent's eaToken.");
      return;
     }

   g_poll++;
   TcHarvestClosures();

   string body = "{";
   body += "\"token\":" + CJson::Quote(InpEaToken);
   body += ",\"account\":" + CJson::Quote(IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)));
   body += ",\"version\":\"1.0.0\",\"platform\":\"mt5\"";
   body += ",\"snapshot\":" + TcSnapshotJson();

   int every = (InpSymbolsEveryPolls <= 0) ? 0 : InpSymbolsEveryPolls;
   if(InpSendSymbols && (g_symbolsSentAt == 0 || every == 0 || (g_poll - g_symbolsSentAt) >= every))
      body += ",\"symbols\":" + TcSymbolsJson();

   body += ",\"positions\":" + TcPositionsJson();
   body += ",\"results\":[" + TcJoin(g_results) + "]";
   body += ",\"events\":[" + TcJoin(g_events) + "]";
   body += "}";

   string response = "";
   int status = TcPost(body, response);

   if(status == 200)
     {
      //--- the agent took the poll, so what we sent is delivered
      ArrayResize(g_results, 0);
      ArrayResize(g_events, 0);
      TcHandleResponse(response);
      return;
     }

   if(status > 0)
      PrintFormat("TradeCopier: agent answered HTTP %d; keeping %d result(s), %d event(s) for the next poll. %s",
                  status, ArraySize(g_results), ArraySize(g_events), StringSubstr(response, 0, 200));
  }

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
int OnInit(void)
  {
   g_url = StringFormat("http://%s:%d/ea", InpEaHost, InpEaPort);
   ArrayResize(g_results, 0);
   ArrayResize(g_events, 0);
   ArrayResize(g_lastTickets, 0);
   g_symbolsSentAt = 0;
   g_poll = 0;

   int period = (int)MathMax(50, InpPollIntervalMs);
   if(!EventSetMillisecondTimer(period))
     {
      Print("TradeCopier: EventSetMillisecondTimer failed");
      return INIT_FAILED;
     }

   PrintFormat("TradeCopier: polling %s every %d ms for account #%d",
               g_url, period, (int)AccountInfoInteger(ACCOUNT_LOGIN));
   if(InpDryRun) Print("TradeCopier: DRY RUN — commands are logged, never sent to the broker.");
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   PrintFormat("TradeCopier: stopped (reason %d)", reason);
  }

void OnTimer(void)
  {
   TcPoll();
  }
//+------------------------------------------------------------------+
