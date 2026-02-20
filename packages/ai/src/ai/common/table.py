import re


class Table:
    @staticmethod
    def _excel_column_name(index):
        """Convert 0-based index to Excel-style column name."""
        name = ''
        while True:
            name = chr(index % 26 + ord('A')) + name
            index = index // 26 - 1
            if index < 0:
                break
        return name

    @staticmethod
    def parse_markdown_table(md: str):
        def to_number(val):
            """Convert string to int/float if possible."""
            try:
                if '.' in val:
                    return float(val)
                return int(val)
            except ValueError:
                return val

        lines = [line.strip() for line in md.strip().splitlines() if '|' in line]

        if not lines:
            return [], []

        rows = [re.split(r'\s*\|\s*', line.strip('| ')) for line in lines]

        has_header = False
        if len(rows) > 1:
            # Detect header separator row like | --- | --- |
            sep_row = rows[1]
            if all(re.fullmatch(r'-{3,}|:{0,1}-{2,}:{0,1}', col.strip()) for col in sep_row):
                has_header = True

        if has_header:
            headers = rows[0]
            data_rows = rows[2:]
        else:
            data_rows = rows
            col_count = len(rows[0])
            headers = [Table._excel_column_name(i) for i in range(col_count)]

        # Convert each row's values to appropriate types
        items = [[to_number(cell) for cell in row] for row in data_rows]

        return headers, items

    @staticmethod
    def generate_markdown_table(data, headers=None, row_numbers=False):
        # Determine column count
        col_count = max(len(row) for row in data) if data else 0

        # Generate headers if not provided
        if headers is None:
            headers = [Table._excel_column_name(i) for i in range(col_count)]

        # Add row numbers if requested
        if row_numbers:
            headers = ['#'] + headers
            data = [[i + 1] + list(row) for i, row in enumerate(data)]

        # Normalize rows (fill missing with "")
        normalized_data = []
        for row in data:
            row = list(row)
            if len(row) < len(headers):
                row += [''] * (len(headers) - len(row))
            normalized_data.append(row)

        # Convert all cells to strings WITHOUT padding
        str_rows = [[str(cell) for cell in row] for row in [headers] + normalized_data]

        # Build lines WITHOUT padding
        def format_row(row):
            return '|' + '|'.join(str(cell) for cell in row) + '|'

        lines = [format_row(str_rows[0])]

        # Fixed minimal separator (3 dashes) per column, no padding
        separator = '|' + '|'.join('---' for _ in headers) + '|'
        lines.append(separator)

        for row in str_rows[1:]:
            lines.append(format_row(row))

        return '\n'.join(lines)
