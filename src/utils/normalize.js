export function normalizeProduct(p, src){
  return {
    id: p.id || p.productId || Math.random().toString(36).slice(2),
    title: p.title || p.name,
    price: p.salePrice || p.price || 0,
    rating: p.rating || p.averageRating || 0,
    seller: p.seller || p.merchant || src,
    image: p.image || (p.images && p.images[0]) || null,
    deeplink: p.deeplink || p.url || '#',
    type: 'product'
  };
}
export function normalizeReservation(x, provider){
  return {
    id: x.id || Math.random().toString(36).slice(2),
    title: x.title || 'Rezervasyon',
    price: x.price || null,
    rating: x.rating || 0,
    image: x.image || null,
    seller: provider,
    deeplink: x.deeplink || '#',
    type: 'reservation'
  };
}
