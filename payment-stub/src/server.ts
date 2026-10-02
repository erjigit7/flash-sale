import Fastify from 'fastify';

const port = Number(process.env.PORT ?? 4000);

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

await app.listen({ port, host: '0.0.0.0' });
