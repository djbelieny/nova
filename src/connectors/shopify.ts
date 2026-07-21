import { httpJson, type Connector } from './types';

const base = (ctx: any) => `https://${ctx.creds.SHOPIFY_SHOP}.myshopify.com/admin/api/2024-01`;
const auth = (ctx: any) => ({ 'X-Shopify-Access-Token': ctx.creds.SHOPIFY_TOKEN });

export const shopifyConnector: Connector = {
  id: 'shopify',
  label: 'Shopify (orders)',
  authKind: 'api_key',
  credEnv: ['SHOPIFY_SHOP', 'SHOPIFY_TOKEN'],
  actions: {
    list_orders: {
      description: 'List orders. input: { limit?, status? }',
      run: (input, ctx) => httpJson(ctx, 'GET', `${base(ctx)}/orders.json?status=${input.status || 'any'}&limit=${input.limit || 20}`, { headers: auth(ctx) }),
    },
    get_order: {
      description: 'Get an order by id. input: { id }',
      run: (input, ctx) => httpJson(ctx, 'GET', `${base(ctx)}/orders/${encodeURIComponent(input.id)}.json`, { headers: auth(ctx) }),
    },
  },
  triggers: [{
    event: 'shopify.order',
    description: 'Recent orders',
    poll: async (ctx) => {
      const r = await httpJson(ctx, 'GET', `${base(ctx)}/orders.json?status=any&limit=10`, { headers: auth(ctx) });
      return r?.orders || [];
    },
  }],
};
