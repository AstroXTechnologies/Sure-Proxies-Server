/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { onRequest } from 'firebase-functions/v2/https';
import { bootstrap } from './main';

let handler: any;

export const api = onRequest(
  { region: 'us-central1', memory: '512MiB', concurrency: 80 },
  async (req: any, res: any) => {
    try {
      if (!handler) {
        const app: any = await bootstrap();
        const httpAdapterHost =
          typeof app.getHttpAdapter === 'function'
            ? { httpAdapter: app.getHttpAdapter() }
            : app.get('HttpAdapterHost');

        handler = httpAdapterHost.httpAdapter.getInstance();
      }

      return handler(req, res);
    } catch (error) {
      console.error('Function error:', error);
      res.status(500).send('Internal server error');
    }
  },
);
