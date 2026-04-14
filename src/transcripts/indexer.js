import { parseTranscriptFile } from './scanner.js'

/**
 * Parse + upsert a transcript file and its FTS rows.
 * Returns the row (with id) or null on parse fail.
 */
export async function indexFile(db, { tool, jsonlPath, size, mtime }) {
  let parsed
  try { parsed = await parseTranscriptFile(tool, jsonlPath) }
  catch (e) { return null }
  const row = db.upsertTranscriptFile({
    tool,
    nativeId: parsed.nativeId,
    cwd: parsed.cwd,
    jsonlPath,
    size,
    mtime,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    firstUserPrompt: parsed.firstUserPrompt,
    turnCount: parsed.turnCount,
  })
  if (row && parsed.turns?.length) {
    db.writeFtsTurns(row.id, parsed.turns)
  }
  return row
}
