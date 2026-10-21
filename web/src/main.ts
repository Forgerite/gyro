import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/** Gyro was called ccdb: keep the layout and tabs saved under the old key names. */
function migrateStorage() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('ccdb.')) continue;
      const next = `gyro.${key.slice('ccdb.'.length)}`;
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

migrateStorage();
bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
