import { createApp } from './aplicacao';
import { loadConfig } from './configuracao';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
