// server/middleware/countryDetector.js

import geoip from 'geoip-lite';

export const countryConfig = {
  'US': {
    code: 'usa',
    language: 'en',
    currency: 'USD',
    timezone: 'America/New_York',
    domain: 'amazon.com',
    affiliates: ['amazon', 'ebay', 'walmart', 'bestbuy', 'target']
  },
  'DE': {
    code: 'de',
    language: 'de',
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    domain: 'amazon.de',
    affiliates: ['amazon', 'ebay', 'idealo', 'zalando', 'otto', 'mediamarkt', 'saturn']
  },
  'TR': {
    code: 'tr',
    language: 'tr',
    currency: 'TRY',
    timezone: 'Europe/Istanbul',
    domain: 'amazon.com.tr',
    affiliates: ['trendyol', 'hepsiburada', 'n11', 'amazon', 'ebay']
  }
};

export const detectCountry = (req, res, next) => {
  try {
    // 1. Query param kontrol et (?country=US veya ?country=DE)
    let countryCode = req.query?.country?.toUpperCase();
    
    // 2. Header kontrol et
    if (!countryCode) {
      countryCode = req.headers['x-country-code']?.toUpperCase();
    }
    
    // 3. IP'den tespit et
    if (!countryCode) {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                 req.socket?.remoteAddress;
      const geo = geoip.lookup(ip);
      countryCode = geo?.country || 'US'; // Varsayılan ABD
    }
    
    // Sadece desteklenen ülkeler, değilse ABD
    if (!countryConfig[countryCode]) {
      countryCode = 'US';
    }
    
    // Request'e ekle
    req.country = countryConfig[countryCode];
    req.countryCode = countryCode;
    
    // Response header'a ekle
    res.setHeader('X-Country-Code', countryCode);
    res.setHeader('X-Country-Lang', req.country.language);
    
    next();
    
  } catch (error) {
    console.error('Country detection error:', error);
    // Hata durumunda varsayılan ABD
    req.country = countryConfig['US'];
    req.countryCode = 'US';
    next();
  }
};
