const express = require('express');
const router = express.Router();
const verifyUser = require('../middleware/verifyUser');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase admin client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co', 
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// POST /api/download
router.post('/', verifyUser, async (req, res) => {
  try {
    const { productId } = req.body;
    const userId = req.user.id;

    if (!productId) {
      return res.status(400).json({ error: 'Missing productId' });
    }

    // 1 & 2. Query purchases: does user_id + product_id row exist?
    const { data: purchase, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .maybeSingle();

    if (purchaseError || !purchase) {
      // 3. If not → return 403
      return res.status(403).json({ error: 'Purchase not found' });
    }

    // 4. Get ppt_path from products table
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('ppt_path')
      .eq('id', productId)
      .single();

    if (productError || !product || !product.ppt_path) {
      return res.status(404).json({ error: 'Product or file not found' });
    }

    // 5. Generate signed URL (120s expiry)
    const { data: signedUrlData, error: signedUrlError } = await supabase
      .storage
      .from('ppts')
      .createSignedUrl(product.ppt_path, 120);

    if (signedUrlError || !signedUrlData) {
      console.error('Signed URL Gen Error:', signedUrlError);
      return res.status(500).json({ error: 'Failed to generate download link' });
    }

    // 6. Return: { signedUrl }
    res.json({ signedUrl: signedUrlData.signedUrl });

  } catch (err) {
    console.error('Download API Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/download/check/:productId
router.get('/check/:productId', verifyUser, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user.id;

    if (!productId) {
      return res.status(400).json({ error: 'Missing productId' });
    }

    // 1 & 2. Check if purchase exists for user + product
    const { data: purchase, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .maybeSingle();

    if (purchaseError && purchaseError.code !== 'PGRST116') {
      console.error('Check Purchase Error:', purchaseError);
      return res.status(500).json({ error: 'Failed to check purchase' });
    }

    // 3. Return: { purchased: true/false }
    res.json({ purchased: !!purchase });

  } catch (err) {
    console.error('Check API Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
