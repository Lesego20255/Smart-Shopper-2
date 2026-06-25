const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Groq = require('groq-sdk');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ═══════════════════════════════════════════════════════════════
// ROBUST JSON PARSER
// ═══════════════════════════════════════════════════════════════
function cleanAndParseJSON(text) {
  console.log('\n📝 Cleaning AI response...');
  
  let jsonStr = text;
  const arrayMatch = text.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
    console.log('✅ Found JSON array in response');
  } else {
    console.log('⚠️ No JSON array found, trying to extract objects...');
  }
  
  jsonStr = jsonStr
    .replace(/,(\s*})/g, '$1')
    .replace(/,(\s*])/g, '$1')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/:\s*'([^']*)'/g, ':"$1"')
    .replace(/^\uFEFF/, '')
    .replace(/(\{|,)\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
    .trim();

  console.log('🧹 Cleaned JSON string (first 200 chars):', jsonStr.substring(0, 200) + '...');

  try {
    const parsed = JSON.parse(jsonStr);
    console.log('✅ Successfully parsed JSON');
    return parsed;
  } catch (e) {
    console.log('❌ First parse failed:', e.message);
    
    try {
      const fixed = jsonStr
        .replace(/["']([^"']*)["']/g, '"$1"')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      
      const parsed2 = JSON.parse(fixed);
      console.log('✅ Successfully parsed after aggressive fixes');
      return parsed2;
    } catch (e2) {
      console.log('❌ Aggressive fixes also failed');
      
      const productMatches = text.match(/\{[^{}]*"name"[^{}]*\}/g);
      if (productMatches && productMatches.length > 0) {
        console.log(`🔍 Found ${productMatches.length} individual product objects`);
        const products = [];
        for (const match of productMatches) {
          try {
            const cleaned = match.replace(/,(\s*[}\]])/g, '$1');
            const product = JSON.parse(cleaned);
            products.push(product);
          } catch (e3) {
            console.log('⚠️ Skipping invalid product:', e3.message);
          }
        }
        if (products.length > 0) {
          console.log(`✅ Extracted ${products.length} products individually`);
          return products;
        }
      }
      
      throw new Error('Could not parse JSON: ' + e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EXTRACTION ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post('/api/extract', upload.single('image'), async (req, res) => {
  let filePath = null;
  
  try {
    filePath = req.file.path;
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const store = req.body.store;

    console.log(`\n📤 Processing flyer for ${store} store...`);

    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'system',
          content: `You are a JSON extraction assistant. ALWAYS respond with ONLY a valid JSON array. 
NEVER add extra text, explanations, or formatting. 
The response must be a valid JSON array that can be parsed by JSON.parse().`
        },
        {
          role: 'user',
          content: [
            { 
              type: 'text', 
              text: `Extract products from this grocery flyer for ${store} store.

⚠️ CRITICAL RULE FOR COMBO DEALS:
- A COMBO DEAL is a GROUP of items sold together at ONE price
- The items inside a combo DO NOT have individual prices - they are NOT sold separately
- DO NOT extract individual items from a combo as separate products
- CREATE ONE entry for the combo with ALL items inside it

✅ CORRECT way to extract a combo:
{"name": "Tiger Combo Deal", "brand": "Combo Special", "size": "8 items", "price": 399.00, "isCombo": true, "savings": 85, "comboItems": [{"name": "Tiger Rice", "size": "10kg", "qty": 1}, {"name": "D'lite Oil", "size": "2L", "qty": 1}]}

❌ WRONG way (DO NOT do this):
{"name": "Tiger Rice", "price": 0}, {"name": "D'lite Oil", "price": 0}  ← These have NO individual prices!

For regular products (NOT in combos):
{"name": "White Bread", "brand": "Bakers Pride", "size": "700g", "price": 12.50}

ONLY return the JSON array. NO extra text.` 
            },
            { 
              type: 'image_url', 
              image_url: { url: `data:image/jpeg;base64,${base64Image}` } 
            }
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.0
    });

    const rawContent = response.choices[0].message.content;
    console.log('\n📝 Raw AI response (first 300 chars):');
    console.log(rawContent.substring(0, 300) + '...');

    const products = cleanAndParseJSON(rawContent);
    
    // Filter out products with price 0 that might be combo items mistakenly extracted
    const filteredProducts = products.filter(p => {
      // Keep if it's a combo (has comboItems)
      if (p.comboItems && p.comboItems.length > 0) return true;
      // Keep if it has a valid price > 0
      if (p.price > 0) return true;
      // Skip if price is 0 or less
      console.log(`⚠️ Skipping product with zero price: ${p.name}`);
      return false;
    });

    // Add store to each product
    const productsWithStore = filteredProducts.map(p => ({ 
      ...p, 
      store: p.store || store,
      isCombo: p.isCombo || (p.comboItems && p.comboItems.length > 0) || false,
      comboItems: p.comboItems || [],
      savings: p.savings || null,
      price: typeof p.price === 'number' ? p.price : 0
    }));

    console.log(`\n✅ Extracted ${productsWithStore.length} products (filtered out zero-price items)`);
    console.log('📦 Products:', productsWithStore.map(p => p.name).join(', '));

    res.json({ 
      success: true, 
      products: productsWithStore,
      count: productsWithStore.length
    });
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    res.json({ 
      success: false, 
      error: error.message,
      raw: error.response?.data || null
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('🗑️ Cleaned up uploaded file');
    }
  }
});

app.listen(3000, () => {
  console.log('\n✅ Server running on http://localhost:3000');
  console.log('📤 Send POST requests to /api/extract');
});