// server/init.js
import { getAdapterSystemStatus } from './core/adapterRegistry.js';
import { runVitrineS40 } from './core/adapterEngine.js';

console.log('🚀 S200 Adapter Engine - Wrapped Version Başlatılıyor...');

// Sistem durumunu kontrol et
const status = getAdapterSystemStatus();
console.log('📊 Adapter Durumu:', {
  version: status.version,
  totalAdapters: status.totalAdapters,
  totalCategories: status.totalCategories
});

// Test sorgusu
async function testSystem() {
  console.log('\n🧪 Sistem testi başlatılıyor...');
  
  try {
    // Test 1: Ürün arama
    const productResult = await runVitrineS40('iphone 15 pro', { region: 'TR' });
    console.log('✅ Ürün arama testi:', {
      kategori: productResult.category,
      sonuçSayısı: productResult.items?.length || 0,
      başarılı: productResult.ok
    });
    
    // Test 2: Barkod arama
    const barcodeResult = await runVitrineS40('12345678', { region: 'TR' });
    console.log('✅ Barkod arama testi:', {
      sonuçSayısı: barcodeResult.items?.length || 0,
      başarılı: barcodeResult.ok
    });
    
    // Test 3: Avukat arama
    const lawyerResult = await runVitrineS40('istanbul avukat', { region: 'TR' });
    console.log('✅ Avukat arama testi:', {
      kategori: lawyerResult.category,
      sonuçSayısı: lawyerResult.items?.length || 0,
      başarılı: lawyerResult.ok
    });
    
    console.log('\n🎉 Tüm testler başarılı! Sistem hazır.');
    
  } catch (error) {
    console.error('❌ Sistem testinde hata:', error);
  }
}

// Başlat
testSystem();