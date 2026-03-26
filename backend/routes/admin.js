const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase admin client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co', 
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Set up Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Admin Middleware
const verifyAdmin = (req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD || 'placeholder';
  if (req.headers.authorization !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized: Invalid admin credentials' });
  }
  next();
};

router.use(verifyAdmin);

// POST /api/admin/product
router.post('/product', upload.fields([
  { name: 'pptFile', maxCount: 1 },
  { name: 'previewImages', maxCount: 5 }
]), async (req, res) => {
  try {
    const { title, description, price, subject, total_slides } = req.body;
    const pptFile = req.files && req.files['pptFile'] ? req.files['pptFile'][0] : null;
    const previewImages = req.files && req.files['previewImages'] ? req.files['previewImages'] : [];

    if (!title || !price || !pptFile || previewImages.length === 0) {
      return res.status(400).json({ error: 'Missing required text fields or files' });
    }

    const productId = crypto.randomUUID();
    
    // 2. Upload PPT to 'ppts' private bucket
    const pptPath = `products/${productId}/${pptFile.originalname}`;
    const { error: pptUploadError } = await supabase.storage
      .from('ppts')
      .upload(pptPath, pptFile.buffer, {
        contentType: pptFile.mimetype,
        upsert: true
      });

    if (pptUploadError) {
      console.error('PPT Upload Error:', pptUploadError);
      return res.status(500).json({ error: 'Failed to upload presentation file to storage' });
    }

    // 3. Upload previews to 'previews' public bucket
    const previewPaths = [];
    for (let i = 0; i < previewImages.length; i++) {
      const img = previewImages[i];
      const imgPath = `previews/${productId}/${i}.jpg`;
      const { error: imgUploadError } = await supabase.storage
        .from('previews')
        .upload(imgPath, img.buffer, {
          contentType: img.mimetype || 'image/jpeg',
          upsert: true
        });
      
      if (imgUploadError) {
        console.error('Image Upload Error:', imgUploadError);
        return res.status(500).json({ error: 'Failed to upload preview image' });
      }
      previewPaths.push(imgPath);
    }

    // 4. Insert product row
    const thumbnail = previewPaths[0]; // Set the first uploaded preview as the primary thumbnail

    const { error: insertError } = await supabase
      .from('products')
      .insert([{
        id: productId,
        title,
        description: description || '',
        price: parseInt(price, 10),
        subject: subject || 'Uncategorized',
        total_slides: parseInt(total_slides, 10) || 0,
        ppt_path: pptPath,
        preview_paths: previewPaths,
        thumbnail
      }]);

    if (insertError) {
      console.error('Product Insert Error:', insertError);
      return res.status(500).json({ error: 'Failed to record product in database' });
    }

    // 5. Return success
    res.json({ success: true, productId });

  } catch (err) {
    console.error('Admin Upload Product Error:', err);
    res.status(500).json({ error: 'Internal server error while uploading' });
  }
});

// DELETE /api/admin/product/:id
router.delete('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Get product row to find file paths
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('ppt_path, preview_paths')
      .eq('id', id)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // 2. Delete ppt from 'ppts' bucket
    if (product.ppt_path) {
      const { error: pptDelErr } = await supabase.storage.from('ppts').remove([product.ppt_path]);
      if (pptDelErr) console.error('Error deleting PPT:', pptDelErr);
    }

    // 3. Delete previews from 'previews' bucket
    if (product.preview_paths && product.preview_paths.length > 0) {
      const { error: previewDelErr } = await supabase.storage.from('previews').remove(product.preview_paths);
      if (previewDelErr) console.error('Error deleting previews:', previewDelErr);
    }

    // 4. Delete product row
    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('Product Delete Row Error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete product from database' });
    }

    // 5. Return success
    res.json({ success: true });

  } catch (err) {
    console.error('Admin Delete Product Error:', err);
    res.status(500).json({ error: 'Internal server error while deleting' });
  }
});

// GET /api/admin/products
router.get('/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*') // Intentionally include ppt_path for admin management
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Admin Products Error:', error);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }

    res.json(data);
  } catch (err) {
    console.error('Admin Get Products Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
