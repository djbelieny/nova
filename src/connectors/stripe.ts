import { httpJson, type Connector } from './types';

const BASE = 'https://api.stripe.com/v1';
const auth = (ctx: any) => ({ Authorization: `Bearer ${ctx.creds.STRIPE_API_KEY}` });

export const stripeConnector: Connector = {
  id: 'stripe',
  label: 'Stripe (payments)',
  authKind: 'api_key',
  credEnv: ['STRIPE_API_KEY'],
  actions: {
    list_charges: {
      description: 'List recent charges. input: { limit? }',
      run: (input, ctx) => httpJson(ctx, 'GET', `${BASE}/charges?limit=${input.limit || 10}`, { headers: auth(ctx) }),
    },
    get_customer: {
      description: 'Get a customer by id. input: { id }',
      run: (input, ctx) => httpJson(ctx, 'GET', `${BASE}/customers/${encodeURIComponent(input.id)}`, { headers: auth(ctx) }),
    },
    create_refund: {
      description: 'Refund a charge. input: { charge, amount? }',
      write: true,
      run: (input, ctx) => httpJson(ctx, 'POST', `${BASE}/refunds`, { headers: auth(ctx), form: { charge: input.charge, ...(input.amount ? { amount: String(input.amount) } : {}) } }),
    },
  },
  triggers: [{
    event: 'stripe.payment',
    description: 'Recent successful charges',
    poll: async (ctx) => {
      const r = await httpJson(ctx, 'GET', `${BASE}/charges?limit=10`, { headers: auth(ctx) });
      return (r?.data || []).filter((c: any) => c.paid);
    },
  }],
};
