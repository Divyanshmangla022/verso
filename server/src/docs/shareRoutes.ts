import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { toPublicUser } from '../auth/service.ts';
import { shares, toObjectId, users } from '../db.ts';
import { asyncRoute, badRequest, notFound, parseBody, pathParam } from '../http/errors.ts';
import { requireDocAccess } from './access.ts';

const grantSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  role: z.enum(['viewer', 'editor']),
});

/** Mounted at /api/docs - sharing is owner-only by design (documented scope cut: no re-sharing). */
export const shareRouter = Router();
shareRouter.use(requireAuth);

// POST /api/docs/:id/shares - grant (or update) access for another user by email.
shareRouter.post(
  '/:id/shares',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { email, role } = parseBody(grantSchema, req.body);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'owner');

    const target = await users().findOne({ email });
    if (!target) {
      throw notFound(`No Verso account exists for ${email}. Ask them to register first.`);
    }
    if (target._id.equals(user._id)) {
      throw badRequest('You already own this document');
    }

    await shares().updateOne(
      { docId: doc._id, userId: target._id },
      {
        $set: { role },
        $setOnInsert: { docId: doc._id, userId: target._id, grantedBy: user._id, createdAt: new Date() },
      },
      { upsert: true },
    );
    const entry = await shares().findOne({ docId: doc._id, userId: target._id });
    res.status(201).json({
      user: toPublicUser(target),
      role,
      createdAt: (entry?.createdAt ?? new Date()).toISOString(),
    });
  }),
);

// DELETE /api/docs/:id/shares/:userId - revoke access.
shareRouter.delete(
  '/:id/shares/:userId',
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { doc } = await requireDocAccess(user._id, pathParam(req, 'id'), 'owner');
    const targetId = toObjectId(pathParam(req, 'userId'));
    if (!targetId) throw notFound('Share not found');
    const result = await shares().deleteOne({ docId: doc._id, userId: targetId });
    if (result.deletedCount === 0) throw notFound('Share not found');
    res.status(204).end();
  }),
);
