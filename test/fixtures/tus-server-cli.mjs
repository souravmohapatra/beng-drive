import { createFixtureServer } from './tus-server.mjs';

const { server } = await createFixtureServer({
  root: '/data', fixture: false, expectedSource: process.env.FIXTURE_NFS_SOURCE, port: 4361,
});
console.log('FIXTURE_SERVER_READY', process.pid);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
