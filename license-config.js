// Verkauf über Polar (polar.sh, Organisation „nexray-prompter“). Polar ist Händler (Merchant of Record),
// kümmert sich um Rechnung und Mehrwertsteuer und liefert die Lizenzschlüssel aus.
// Stand 29.10.2026: Produkte, Lizenz-Benefits, Kauf-Links und Rabatt START20 angelegt.
export const LICENSE = {
  organizationId: '638221a5-e7c1-430d-80dc-31d66664a450',
  // Benefit-ID (Lizenzschlüssel je Produkt) → Tarif. billing bestimmt, wie lange Pro ohne Internet weiterläuft.
  benefits: {
    '9389e1b3-a396-4b09-916b-07d164ce4bf8': { plan: 'pro', billing: 'month' }, // Pro monatlich 7,99 €, 3 Geräte
    '08d361d4-ca63-454c-866f-fef9798beb36': { plan: 'pro', billing: 'year' }, // Pro jährlich 71,91 €, 3 Geräte
    'c8d59c74-b62d-4030-81f7-ae5e39a8d675': { plan: 'business', billing: 'year' }, // Business 399 €/Jahr, 20 Geräte
  },
  // Kauf-Links (Polar → Products → Checkout Links). Monat und Jahr wählt der Kunde an der Kasse.
  buy: {
    month: 'https://buy.polar.sh/polar_cl_4nrs6Rc7KHcYBOyDdCQ61gpsuxhrc7ainHoN54XfqQP',
    year: 'https://buy.polar.sh/polar_cl_4nrs6Rc7KHcYBOyDdCQ61gpsuxhrc7ainHoN54XfqQP',
  },
  business: 'https://buy.polar.sh/polar_cl_uqjShlWmFG90zQ7XtQdxX9Kvo5PgSRN4feGPG3Ccbj9',
  // Kundenportal: Abo verwalten, Rechnungen, Geräte abmelden.
  portal: 'https://polar.sh/nexray-prompter/portal',
};
