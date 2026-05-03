# Computer Access MCP — E2E Test Prompts

Run each prompt against the agent after starting the MCP server with `npm start`.
Expected: every tool call succeeds and returns the described output.

---

## 1. fs-manage: read
**Prompt:** "Read the file `~/Documents/computer-access/package.json`"
**Expect:** JSON content of package.json displayed.

## 2. fs-manage: write + read-back
**Prompt:** "Create a file `~/Documents/computer-access/tests/_scratch.txt` with the content 'hello e2e' and then read it back"
**Expect:** File created, content matches 'hello e2e'.

## 3. fs-manage: smart-edit
**Prompt:** "In `~/Documents/computer-access/tests/_scratch.txt`, replace 'hello e2e' with 'smart-edit works'"
**Expect:** File updated, old string replaced.

## 4. fs-manage: patch
**Prompt:** "Apply this unified diff to `~/Documents/computer-access/tests/_scratch.txt`:
```
@@ -1,1 +1,2 @@
-smart-edit works
+smart-edit works
+patch line added
```"
**Expect:** File now has two lines.

## 5. fs-manage: tree
**Prompt:** "Show me the directory tree of `~/Documents/computer-access/src`"
**Expect:** Tree output with server.ts, start.ts visible.

## 6. fs-manage: batch-read
**Prompt:** "Read these files together: `~/Documents/computer-access/src/start.ts` and `~/Documents/computer-access/package.json`"
**Expect:** Both file contents returned.

## 7. fs-search: regex-search
**Prompt:** "Search for 'KILL_SWITCH' in the `~/Documents/computer-access/src` directory"
**Expect:** Matches in server.ts showing kill switch code.

## 8. fs-search: file-search
**Prompt:** "Find all `.ts` files in `~/Documents/computer-access/src`"
**Expect:** List of TypeScript files.

## 9. sys-manage: info
**Prompt:** "Show me system information"
**Expect:** OS, CPU, memory, uptime info.

## 10. sys-manage: exec
**Prompt:** "Run `echo 'e2e test passed'` in the terminal"
**Expect:** Output: 'e2e test passed'.

## 11. sys-manage: clipboard-write + clipboard-read
**Prompt:** "Write 'clipboard-e2e' to the clipboard, then read it back"
**Expect:** Clipboard contains 'clipboard-e2e'.

## 12. git-manage: status
**Prompt:** "Show git status of `~/Documents/computer-access`"
**Expect:** Git status output (modified files, branch info).

## 13. net-manage: port-check
**Prompt:** "Check if port 8123 is in use"
**Expect:** Port status reported (should be in use since MCP is running).

## 14. net-manage: web-search
**Prompt:** "Search the web for 'MCP protocol specification'"
**Expect:** Search results returned.

## 15. browser-manage: navigate + get-text
**Prompt:** "Navigate to https://example.com and get the page text"
**Expect:** Page content from example.com.

## 16. doc-manage: csv
**Prompt:** "Create a CSV file at `~/Documents/computer-access/tests/_test.csv` with headers 'name,score' and one row 'alice,100', then read it with doc-manage"
**Expect:** CSV parsed and displayed.

## 17. Kill switch test
**Prompt:** "Run `touch ~/.mcp_kill` then try to read a file. After verifying it's blocked, run `rm ~/.mcp_kill`"
**Expect:** 503 KillSwitchActive error when kill switch is active, normal operation after removal.

---

## Cleanup
**Prompt:** "Delete `~/Documents/computer-access/tests/_scratch.txt` and `~/Documents/computer-access/tests/_test.csv`"
**Expect:** Both temp files removed.
