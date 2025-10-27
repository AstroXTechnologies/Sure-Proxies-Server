import * as functions from 'firebase-functions';

const config = functions.config();
if (config && typeof config === 'object') {
  if (config.app) {
    const firebaseEnv: Record<string, string> = config.app as Record<
      string,
      string
    >;
    Object.keys(firebaseEnv).forEach((key) => {
      process.env[key.toUpperCase()] = firebaseEnv[key];
    });
  }
}
