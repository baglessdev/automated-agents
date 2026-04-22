// GitHub webhook HMAC-SHA256 signature verification.
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
//
// Express attaches the raw body buffer via the `verify` callback in
// express.json() — without it we'd only see the parsed body, which has
// been re-serialized and will not match the signature.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function verifyGitHubSignature(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
): void {
  const signatureHeader = req.get('x-hub-signature-256') ?? '';
  const body = req.rawBody;

  if (!body) {
    res.status(400).send('missing body');
    return;
  }

  const expected =
    'sha256=' +
    createHmac('sha256', config.githubWebhookSecret)
      .update(body)
      .digest('hex');

  const gotBuf = Buffer.from(signatureHeader);
  const wantBuf = Buffer.from(expected);

  if (
    gotBuf.length !== wantBuf.length ||
    !timingSafeEqual(gotBuf, wantBuf)
  ) {
    res.status(401).send('bad signature');
    return;
  }

  next();
}
