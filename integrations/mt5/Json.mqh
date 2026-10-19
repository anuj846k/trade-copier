//+------------------------------------------------------------------+
//|                                                       Json.mqh   |
//|  Minimal JSON reader/builder for the Trade Copier bridge EA.      |
//|                                                                  |
//|  MQL5 ships no JSON support and a full library is a large          |
//|  dependency to audit, so this is a deliberately small            |
//|  recursive-descent parser: it covers objects, arrays, strings,    |
//|  numbers, booleans and null, which is everything the bridge        |
//|  protocol uses. It does not implement JSON5, duplicate-key        |
//|  detection or number precision beyond a double.                   |
//+------------------------------------------------------------------+
#ifndef TC_JSON_MQH
#define TC_JSON_MQH

enum ENUM_JSON_TYPE
  {
   JSON_NULL = 0,
   JSON_BOOL,
   JSON_NUMBER,
   JSON_STRING,
   JSON_ARRAY,
   JSON_OBJECT
  };

//+------------------------------------------------------------------+
//| A parsed JSON value.                                             |
//+------------------------------------------------------------------+
class CJson
  {
public:
   ENUM_JSON_TYPE     type;
   bool               bval;
   double             nval;
   string             sval;
   CJson             *items[];   // JSON_ARRAY elements
   string             okeys[];   // JSON_OBJECT keys
   CJson             *ovals[];   // JSON_OBJECT values

                     CJson(void) { type = JSON_NULL; bval = false; nval = 0.0; sval = ""; }
                    ~CJson(void) { Clear(); }

   void              Clear(void)
     {
      for(int i = 0; i < ArraySize(items); i++)
         if(items[i] != NULL)
            delete items[i];
      ArrayResize(items, 0);

      for(int i = 0; i < ArraySize(ovals); i++)
         if(ovals[i] != NULL)
            delete ovals[i];
      ArrayResize(ovals, 0);
      ArrayResize(okeys, 0);
     }

   void              Append(CJson *value)
     {
      int n = ArraySize(items);
      ArrayResize(items, n + 1);
      items[n] = value;
     }

   void              Put(const string key, CJson *value)
     {
      int n = ArraySize(ovals);
      ArrayResize(okeys, n + 1);
      ArrayResize(ovals, n + 1);
      okeys[n] = key;
      ovals[n] = value;
     }

   int               Count(void) const
     {
      return (type == JSON_ARRAY) ? ArraySize(items) : ArraySize(ovals);
     }

   CJson            *At(const int index)
     {
      if(type != JSON_ARRAY) return NULL;
      if(index < 0 || index >= ArraySize(items)) return NULL;
      return items[index];
     }

   CJson            *Get(const string key)
     {
      if(type != JSON_OBJECT) return NULL;
      for(int i = 0; i < ArraySize(okeys); i++)
         if(okeys[i] == key)
            return ovals[i];
      return NULL;
     }

   bool              Has(const string key) { return Get(key) != NULL; }

   string            GetStr(const string key, const string fallback = "")
     {
      CJson *v = Get(key);
      if(v == NULL) return fallback;
      if(v.type == JSON_STRING) return v.sval;
      if(v.type == JSON_NUMBER) return DoubleToString(v.nval, 8);
      if(v.type == JSON_BOOL) return v.bval ? "true" : "false";
      return fallback;
     }

   double            GetNum(const string key, const double fallback = 0.0)
     {
      CJson *v = Get(key);
      if(v == NULL) return fallback;
      if(v.type == JSON_NUMBER) return v.nval;
      if(v.type == JSON_STRING) return StringToDouble(v.sval);
      if(v.type == JSON_BOOL) return v.bval ? 1.0 : 0.0;
      return fallback;
     }

   bool              GetBool(const string key, const bool fallback = false)
     {
      CJson *v = Get(key);
      if(v == NULL) return fallback;
      if(v.type == JSON_BOOL) return v.bval;
      if(v.type == JSON_NUMBER) return v.nval != 0.0;
      if(v.type == JSON_STRING) return v.sval == "true" || v.sval == "1";
      return fallback;
     }

   //--- number-or-null helpers, for the nullable protocol fields ------
   bool              IsNull(const string key)
     {
      CJson *v = Get(key);
      return (v == NULL || v.type == JSON_NULL);
     }

   static string     Quote(const string value)
     {
      string out = "\"";
      int len = StringLen(value);
      for(int i = 0; i < len; i++)
        {
         ushort c = StringGetCharacter(value, i);
         if(c == '"')       out += "\\\"";
         else if(c == '\\') out += "\\\\";
         else if(c == '\n') out += "\\n";
         else if(c == '\r') out += "\\r";
         else if(c == '\t') out += "\\t";
         else if(c < 0x20)  out += " ";
         else               out += ShortToString(c);
        }
      return out + "\"";
     }

   //--- numbers are rendered with a fixed precision; callers that care
   //--- about prices pass the symbol's digits (see NumberFixed) --------
   static string     Number(const double value, const int digits = 8)
     {
      if(value == MathRound(value) && MathAbs(value) < 1e15)
         return IntegerToString((long)value);
      return DoubleToString(value, digits);
     }

   static string     NumberFixed(const double value, const int digits)
     {
      return DoubleToString(value, digits);
     }

   string            Raw(const string key)
     {
      CJson *v = Get(key);
      if(v == NULL || v.type == JSON_NULL) return "null";
      if(v.type == JSON_STRING) return Quote(v.sval);
      if(v.type == JSON_BOOL) return v.bval ? "true" : "false";
      if(v.type == JSON_NUMBER) return Number(v.nval, 8);
      return "null";
     }
  };

//+------------------------------------------------------------------+
//| Recursive-descent parser. Returns NULL on malformed input.        |
//+------------------------------------------------------------------+
class CJsonParser
  {
private:
   string            m_s;
   int               m_i;
   int               m_len;

   ushort            Peek(void) const { return (m_i < m_len) ? StringGetCharacter(m_s, m_i) : 0; }

   void              SkipWs(void)
     {
      while(m_i < m_len)
        {
         ushort c = StringGetCharacter(m_s, m_i);
         if(c == ' ' || c == '\t' || c == '\n' || c == '\r') m_i++;
         else break;
        }
     }

   bool              Literal(const string text)
     {
      int n = StringLen(text);
      if(StringSubstr(m_s, m_i, n) != text) return false;
      m_i += n;
      return true;
     }

   string            ParseString(void)
     {
      string out = "";
      if(Peek() != '"') return out;
      m_i++;
      while(m_i < m_len)
        {
         ushort c = StringGetCharacter(m_s, m_i);
         if(c == '"') { m_i++; break; }
         if(c == '\\')
           {
            m_i++;
            ushort e = Peek();
            m_i++;
            if(e == '"')       out += "\"";
            else if(e == '\\') out += "\\";
            else if(e == '/')  out += "/";
            else if(e == 'b')  out += "\b";
            else if(e == 'f')  out += "\f";
            else if(e == 'n')  out += "\n";
            else if(e == 'r')  out += "\r";
            else if(e == 't')  out += "\t";
            else if(e == 'u')
              {
               string hex = StringSubstr(m_s, m_i, 4);
               m_i += 4;
               out += ShortToString((ushort)StringToInteger("0x" + hex));
              }
            continue;
           }
         out += ShortToString(c);
         m_i++;
        }
      return out;
     }

   double            ParseNumber(void)
     {
      string digits = "";
      while(m_i < m_len)
        {
         ushort c = StringGetCharacter(m_s, m_i);
         if((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
           {
            digits += ShortToString(c);
            m_i++;
           }
         else break;
        }
      return StringToDouble(digits);
     }

   CJson            *ParseValue(void)
     {
      SkipWs();
      ushort c = Peek();
      CJson *value = new CJson();

      if(c == '{') { value.type = JSON_OBJECT; ParseObject(value); return value; }
      if(c == '[') { value.type = JSON_ARRAY;  ParseArray(value);  return value; }
      if(c == '"') { value.type = JSON_STRING; value.sval = ParseString(); return value; }
      if(c == 't' && Literal("true"))  { value.type = JSON_BOOL; value.bval = true;  return value; }
      if(c == 'f' && Literal("false")) { value.type = JSON_BOOL; value.bval = false; return value; }
      if(c == 'n' && Literal("null"))  { value.type = JSON_NULL; return value; }
      if(c == 0) { delete value; return NULL; }

      value.type = JSON_NUMBER;
      value.nval = ParseNumber();
      return value;
     }

   void              ParseObject(CJson *obj)
     {
      m_i++; // '{'
      SkipWs();
      if(Peek() == '}') { m_i++; return; }
      while(m_i < m_len)
        {
         SkipWs();
         string key = ParseString();
         SkipWs();
         if(Peek() == ':') m_i++;
         CJson *value = ParseValue();
         obj.Put(key, value);
         SkipWs();
         ushort c = Peek();
         if(c == ',') { m_i++; continue; }
         if(c == '}') { m_i++; break; }
         break;
        }
     }

   void              ParseArray(CJson *arr)
     {
      m_i++; // '['
      SkipWs();
      if(Peek() == ']') { m_i++; return; }
      while(m_i < m_len)
        {
         CJson *value = ParseValue();
         arr.Append(value);
         SkipWs();
         ushort c = Peek();
         if(c == ',') { m_i++; continue; }
         if(c == ']') { m_i++; break; }
         break;
        }
     }

public:
                     CJsonParser(void) { m_i = 0; m_len = 0; }

   CJson            *Parse(const string source)
     {
      m_s = source;
      m_i = 0;
      m_len = StringLen(source);
      SkipWs();
      if(m_len == 0) return NULL;
      return ParseValue();
     }
  };

//+------------------------------------------------------------------+
//| ISO-8601 UTC timestamp. Uses TimeGMT, not the terminal's server   |
//| time: the engine compares timestamps across machines.             |
//+------------------------------------------------------------------+
string TcIso8601(const datetime when)
  {
   MqlDateTime parts;
   TimeToStruct(when, parts);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       parts.year, parts.mon, parts.day, parts.hour, parts.min, parts.sec);
  }

#endif // TC_JSON_MQH
//+------------------------------------------------------------------+
