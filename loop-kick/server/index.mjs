import { createLoopKickServer } from './app.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const service = createLoopKickServer();

service.server.listen(port, host, () => {
  console.log(`LOOP-KICK listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  console.log(`LOOP-KICK received ${signal}; shutting down`);
  await service.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
