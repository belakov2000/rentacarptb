// Тестова база вместо Netlify Database: функциите ползват state.db (drizzle върху временна PostgreSQL база)
export const state: { db: any } = { db: null };
export const db = new Proxy({}, { get: (_t, p) => (state.db as any)[p] }) as any;
