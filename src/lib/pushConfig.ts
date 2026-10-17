/**
 * Whether this deployment sends web push, and the public key a browser subscribes with: two
 * environment values, in a leaf that imports nothing. A page or an action that only asks these (the
 * match page, My matches, the share page, the push switch) does not load web-push and its crypto just
 * to read them. `src/lib/push.ts` sends, and it reads the keys from here too. Off until both VAPID keys
 * are set (rule 4).
 */
export const pushEnabled = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? null;
