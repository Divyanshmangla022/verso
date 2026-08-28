/**
 * Seed demo accounts and sample documents so reviewers can exercise the
 * sharing flow immediately. Idempotent: safe to run repeatedly.
 *
 * Demo credentials (override via SEED_PASSWORD):
 *   ada@demo.verso.app    / VersoDemo1!
 *   grace@demo.verso.app  / VersoDemo1!
 */
import bcrypt from 'bcryptjs';
import { config } from './config.ts';
import { closeDb, connectDb, documents, shares, users } from './db.ts';
import { importFile } from './files/importers.ts';
import { recordRevision } from './docs/versions.ts';

const PASSWORD = process.env.SEED_PASSWORD ?? 'VersoDemo1!';

const DEMO_USERS = [
  { email: 'ada@demo.verso.app', name: 'Ada Lovelace' },
  { email: 'grace@demo.verso.app', name: 'Grace Hopper' },
];

// Seed content is authored as Markdown and run through the real import
// pipeline, so seeding exercises the same code path as user uploads.
const WELCOME_MD = `# Welcome to Verso

Verso is a lightweight collaborative document editor with an AI writing layer.

## What you can do here

- Write with **bold**, *italic*, underline, headings, and lists
- Import \`.txt\`, \`.md\`, or \`.docx\` files as new documents
- Attach files to any document
- Share documents with teammates as a viewer or an editor
- Ask the built-in AI to rewrite, summarize, or answer questions about a doc

## Try it

1. Select any sentence in this document
2. Use the floating AI menu to rewrite it
3. Open the share dialog and invite the other demo account
`;

const ROADMAP_MD = `# Q3 Product Roadmap (sample)

## Themes

1. Collaboration depth
2. Editor performance
3. AI assistance quality

## Committed work

- Version history with restore
- Attachment previews
- Faster document list loading

> This is a sample shared document. Ada owns it; Grace has editor access.
`;

async function main(): Promise<void> {
  await connectDb();
  const passwordHash = await bcrypt.hash(PASSWORD, config.bcryptRounds);

  const ids: Record<string, import('mongodb').ObjectId> = {};
  for (const u of DEMO_USERS) {
    const existing = await users().findOneAndUpdate(
      { email: u.email },
      { $setOnInsert: { email: u.email, name: u.name, passwordHash, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!existing) throw new Error(`Failed to seed user ${u.email}`);
    ids[u.email] = existing._id;
    console.log(`user ready: ${u.email}`);
  }

  const seedDoc = async (ownerEmail: string, markdown: string, filename: string) => {
    const ownerId = ids[ownerEmail];
    const { title, content } = await importFile(filename, Buffer.from(markdown, 'utf8'));
    const existing = await documents().findOne({ ownerId, title });
    if (existing) {
      console.log(`doc exists: "${title}"`);
      return existing._id;
    }
    const now = new Date();
    const result = await documents().insertOne({
      title,
      ownerId,
      content,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as Parameters<ReturnType<typeof documents>['insertOne']>[0]);
    await recordRevision({ docId: result.insertedId, version: 1, title, content, savedBy: ownerId, at: now });
    console.log(`doc created: "${title}" (owner ${ownerEmail})`);
    return result.insertedId;
  };

  await seedDoc('ada@demo.verso.app', WELCOME_MD, 'welcome.md');
  await seedDoc('grace@demo.verso.app', WELCOME_MD, 'welcome.md');
  const roadmapId = await seedDoc('ada@demo.verso.app', ROADMAP_MD, 'roadmap.md');

  // Demonstrate sharing out of the box: Ada's roadmap -> Grace as editor.
  await shares().updateOne(
    { docId: roadmapId, userId: ids['grace@demo.verso.app'] },
    {
      $set: { role: 'editor' },
      $setOnInsert: {
        docId: roadmapId,
        userId: ids['grace@demo.verso.app'],
        grantedBy: ids['ada@demo.verso.app'],
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  console.log('share ready: roadmap -> grace@demo.verso.app (editor)');

  await closeDb();
  console.log('\nSeed complete. Log in with:');
  for (const u of DEMO_USERS) console.log(`  ${u.email} / ${PASSWORD}`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
