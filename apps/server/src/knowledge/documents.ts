import { KnowledgeDocumentZip } from './knowledge-document-zip.ts'

/**
 * Uploaded documents in the vault (PLAN 6.6): PDF, DOCX, CSV, JSON, HTML, images and zips next to the Markdown notes.
 * The files are the truth; the DB rows and the FTS text are an index. All changes run through the vault's lock.
 */
export class KnowledgeDocuments extends KnowledgeDocumentZip {}
