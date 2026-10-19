import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';

export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'left' | 'right' | 'center';
  readonly className?: string;
}

/**
 * Small table wrapper: header/body/empty state in one place so every list view
 * behaves the same when it has no rows.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyTitle = 'Nothing to show yet',
  emptyDescription,
  emptyAction,
  onRowClick,
}: {
  columns: ReadonlyArray<Column<Row>>;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onRowClick?: (row: Row) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} {...(emptyAction ? { action: emptyAction } : {})} />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.key} className={column.className} style={column.align ? { textAlign: column.align } : undefined}>
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            className={onRowClick ? 'cursor-pointer' : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((column) => (
              <TableCell key={column.key} className={column.className} style={column.align ? { textAlign: column.align } : undefined}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
