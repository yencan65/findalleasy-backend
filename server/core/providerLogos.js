// providerLogos.js — Minimal Clean Edition

export function injectProviderLogo(item) {
  if (!item || !item.provider) return item;

  const prov = item.provider.toLowerCase();

  const logos = {
    trendyol: "https://findalleasy.com/logos/trendyol.png",
    hepsiburada: "https://findalleasy.com/logos/hepsiburada.png",
    amazon: "https://findalleasy.com/logos/amazon.png",
    n11: "https://findalleasy.com/logos/n11.png",
    googleshopping: "https://findalleasy.com/logos/google.png",
    booking: "https://findalleasy.com/logos/booking.png",
    skyscanner: "https://findalleasy.com/logos/skyscanner.png",
    getyourguide: "https://findalleasy.com/logos/getyourguide.png",
    sahibinden: "https://findalleasy.com/logos/sahibinden.png",
    emlakjet: "https://findalleasy.com/logos/emlakjet.png",
    zara: "https://findalleasy.com/logos/zara.png",
    ikea: "https://findalleasy.com/logos/ikea.png",
  };

  const logo = logos[prov];

  return {
    ...item,
    logo: logo || null,
  };
}
