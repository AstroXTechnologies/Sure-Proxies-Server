/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import * as functions from 'firebase-functions';
import { bootstrap } from './main';

// Use `any` at the runtime boundary to avoid conflicts between different
// versions of @types/express in the workspace. The Nest app created by
// bootstrap() provides the adapter; we extract its Express instance and
// reuse it across function invocations.

let handler: any;

export const api = functions.https.onRequest(async (req: any, res: any) => {
  try {
    if (!handler) {
      // bootstrap() returns a fully configured Nest application
      const app: any = await bootstrap();

      // Prefer symbol lookup via HttpAdapterHost string to avoid importing the
      // type here (keeps this file type-agnostic).
      const adapterHost: any =
        app.get('HttpAdapterHost') || app.get('HttpAdapterHost' as any);
      if (!adapterHost || !adapterHost.httpAdapter) {
        console.error('Failed to obtain HTTP adapter from Nest app');
        res.status(500).send('Server misconfigured');
        return;
      }

      handler = adapterHost.httpAdapter.getInstance();
      if (!handler || typeof handler !== 'function') {
        console.error('Express handler missing');
        res.status(500).send('Server misconfigured');
        return;
      }
    }

    return handler(req, res);
  } catch (e) {
    console.error('Function error', e);
    res.status(500).send('Internal server error');
  }
});
