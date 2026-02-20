package com.rocketride.tika_api;

import java.util.ArrayList;

public class Table {
	private class TableRow extends ArrayList<String> {
	};

	private class TableSection extends ArrayList<TableRow> {
	};

	static final int TABLE_DEFAULT = -1;
	static final int TABLE_HEAD = 0;
	static final int TABLE_BODY = 1;
	static final int TABLE_FOOT = 2;

	private TableSection[] table;
	TableRow row;
	String text = "";
	int tableSection = TABLE_DEFAULT;
	boolean hasHeaders = false;

	public Table() {
		// Create a new set of tables
		table = new TableSection[3];
	}

	//
	// Handle <table></table>
	//
	public void tableStart() {
	}

	public void tableEnd() {
	}

	//
	// Handle <thead></thead>
	//
	public void tableHeaderStart() {
		// Set the section where this will be place
		tableSection = TABLE_HEAD;
	}

	public void tableHeaderEnd() {
		// Reset to table body section
		tableSection = TABLE_DEFAULT;
	}

	//
	// Handle <tbody></tbody>
	//
	public void tableBodyStart() {
		// Set the section where this will be place
		tableSection = TABLE_BODY;
	}

	public void tableBodyEnd() {
		// Reset to table body section
		tableSection = TABLE_DEFAULT;
	}

	//
	// Handle <tfoot></tfoot>
	//
	public void tableFooterStart() {
		// Set the section where this will be place
		tableSection = TABLE_FOOT;
	}

	public void tableFooterEnd() {
		// Reset to table body section
		tableSection = TABLE_DEFAULT;
	}

	//
	// Handle <tr></tr>
	//
	public void tableRowStart() {
	}

	public void tableRowEnd() {
		// If we have no columns, skip this
		if (row != null && row.size() < 0)
			return;

		// Determine what section this is in
		int section;
		if (tableSection != TABLE_DEFAULT)
			section = tableSection;
		else
			section = TABLE_BODY;

		// If this row used th
		if (hasHeaders)
			section = TABLE_HEAD;

		// Make sure the proper section defined
		if (table[section] == null)
			table[section] = new TableSection();

		// Add the row and clear it
		table[section].add(row);
		row = null;

		// Say no headers in this row
		hasHeaders = false;
	}

	//
	// Handle <th></th>
	//
	public void tableHeaderCellStart() {
	}

	public void tableHeaderCellEnd() {
		// Make sure the headings section is there
		if (row == null)
			row = new TableRow();

		// Add the text cell
		row.add(text);
		text = "";

		// If its not aleady set, set it now, there as a th used
		hasHeaders = true;
	}

	//
	// Handle <td></td>
	//
	public void tableDataCellStart() {
	}

	public void tableDataCellEnd() {
		// Make sure the headings section is there
		if (row == null)
			row = new TableRow();

		// Add the text cell
		row.add(text);
		text = "";
	}

	public void tableCellData(String content) {
		// Add a \n between lines
		if (text.length() > 0)
			text += "\n";
		text += content;
	}

	// Determines if there is actually anything in the table
	public boolean isValidTable() {
		if (table[TABLE_HEAD] != null && table[TABLE_HEAD].size() > 0)
			return true;
		if (table[TABLE_BODY] != null && table[TABLE_BODY].size() > 0)
			return true;
		if (table[TABLE_FOOT] != null && table[TABLE_FOOT].size() > 0)
			return true;
		return false;
	}

	//
	// Gets the table as a string
	//
	public String getTableText() {
		StringBuilder str = new StringBuilder();

		// Output heading rows
		for (TableSection section : table) {
			if (section == null)
				continue;

			for (ArrayList<String> row : section) {
				str.append("|");
				for (String cell : row) {
					// Replace all |, \n, " and ' with spaces so the LLM
					// doesn't get confused and we can break rows
					String cellText = cell
						.replace("\n", " ")
						.replace("\"", " ")
						.replace("'", " ")
						.replace("|", "-")
						.trim();

					if (cellText.length() > 0)
						str.append(cellText);
					else
						str.append("-");
					str.append("|");
				}
				str.append("\n");
			}
		}

		// Return the table
		return str.toString();
	}
}
