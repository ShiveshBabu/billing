import '@fastify/session';

declare module 'fastify' {
  interface FastifyRequest {
    session: import('@fastify/session').Session;
  }

  interface Session {
    userId?: string;
    roleId?: string;
    roleCode?: string;
    csrfSecret?: string;
    lastSeenAt?: number;
  }
}
