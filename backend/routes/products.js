const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase admin client here (Service role key used in backend)
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co', 
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// GET /api/products
router.get('/', async (req, res) => {
  try {
    // We strictly select fields and NOT ppt_path
    const { data, error } = await supabase
      .from('products')
      .select('id, title, description, price, subject, total_slides, level, thumbnail, preview_paths');

    if (error) {
      console.error('Error fetching products:', error);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Products API Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Select same set of fields, omitting ppt_path
    const { data, error } = await supabase
      .from('products')
      .select('id, title, description, price, subject, total_slides, level, thumbnail, preview_paths')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { // Supabase equivalent of Not Found on .single()
        return res.status(404).json({ error: 'Product not found' });
      }
      console.error('Error fetching product:', error);
      return res.status(500).json({ error: 'Failed to fetch product' });
    }

    res.json(data);
  } catch (err) {
    console.error('Product API Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
