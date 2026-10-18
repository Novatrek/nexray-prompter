// Verkauf über Lemon Squeezy (Shop nexray.lemonsqueezy.com, Store 500874).
// Stand 18.10.2026: Produkte im Testmodus. Beim Wechsel in den Live-Modus bekommen die Produkte
// neue Varianten-IDs und Kauf-Links – dann hier nachtragen.
export const LICENSE = {
  // Store-ID aus Lemon Squeezy (Settings → Stores). Schlüssel anderer Shops werden abgelehnt.
  storeId: 500874,
  // Varianten-ID → Tarif. billing bestimmt, wie lange Pro ohne Internet weiterläuft.
  variants: {
    2263422: { plan: 'pro', billing: 'month' }, // Pro monatlich 7,99 €
    2263431: { plan: 'pro', billing: 'year' }, // Pro jährlich 71,91 €
    2263460: { plan: 'business', billing: 'year' }, // Business jährlich 399 €, 20 Geräte
  },
  // Kauf-Links (Lemon Squeezy → Products → Share). Monat und Jahr wählt der Kunde an der Kasse.
  buy: {
    month: 'https://nexray.lemonsqueezy.com/checkout/buy/be38ae47-c133-4b11-bf06-998dfa87178c',
    year: 'https://nexray.lemonsqueezy.com/checkout/buy/be38ae47-c133-4b11-bf06-998dfa87178c',
  },
  business: 'https://nexray.lemonsqueezy.com/checkout/buy/3e8b0273-c1a8-4506-a31c-4d2a6c141d73',
};
