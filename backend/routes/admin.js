const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const JSZip = require('jszip');
const xml2js = require('xml2js');
const CloudConvert = require('cloudconvert');
const { createClient } = require('@supabase/supabase-js');

// Initialize CloudConvert (requires API key in .env)
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || 'placeholder');

// Initialize Supabase admin client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co', 
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Helper: Slice PPTX to first 7 slides
async function slicePptx(buffer, maxSlides = 7) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const presXmlPath = 'ppt/presentation.xml';
    const presFile = zip.file(presXmlPath);
    if (!presFile) return buffer;

    const presXmlStr = await presFile.async('string');
    const parser = new xml2js.Parser();
    const builder = new xml2js.Builder();
    const presObj = await parser.parseStringPromise(presXmlStr);
    
    if (presObj['p:presentation'] && presObj['p:presentation']['p:sldIdLst']) {
      const sldIdLst = presObj['p:presentation']['p:sldIdLst'][0]['p:sldId'];
      if (sldIdLst && sldIdLst.length > maxSlides) {
        presObj['p:presentation']['p:sldIdLst'][0]['p:sldId'] = sldIdLst.slice(0, maxSlides);
        const newXmlStr = builder.buildObject(presObj);
        zip.file(presXmlPath, newXmlStr);
        return await zip.generateAsync({ type: 'nodebuffer' });
      }
    }
    return buffer;
  } catch (err) {
    console.error('PPT Slicing Error:', err);
    return buffer;
  }
}

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
  { name: 'thumbnail', maxCount: 1 },
  { name: 'previewPdf', maxCount: 1 }
]), async (req, res) => {
  console.log('--- Product Upload Start ---');
  try {
    const { title, description, price, subject, total_slides, level } = req.body;
    console.log('Backend Received Metadata:', { title, price, subject, total_slides, level });
    
    const pptFile = req.files && req.files['pptFile'] ? req.files['pptFile'][0] : null;
    const thumbnailFile = req.files && req.files['thumbnail'] ? req.files['thumbnail'][0] : null;

    if (!title || !price || !pptFile || !thumbnailFile) {
      console.warn('Missing fields or files:', { 
        hasTitle: !!title, 
        hasPrice: !!price, 
        hasPpt: !!pptFile, 
        hasThumb: !!thumbnailFile 
      });
      return res.status(400).json({ error: 'Missing required text fields or files' });
    }

    console.log('Files metadata:', {
      ppt: { name: pptFile.originalname, size: pptFile.size, type: pptFile.mimetype },
      thumb: { name: thumbnailFile.originalname, size: thumbnailFile.size, type: thumbnailFile.mimetype }
    });

    const productId = crypto.randomUUID();
    
    // 1. Upload Full PPT to 'ppts' private bucket
    const pptPath = `products/${productId}/${pptFile.originalname}`;
    await supabase.storage.from('ppts').upload(pptPath, pptFile.buffer, {
      contentType: pptFile.mimetype,
      upsert: true
    });

    // 2. Handle Preview (Manual PDF or Auto-generate from sliced PPTX)
    let finalPreviewPath = '';
    const manualPdf = req.files && req.files['previewPdf'] ? req.files['previewPdf'][0] : null;

    if (manualPdf) {
      console.log('Using manual PDF preview override');
      finalPreviewPath = `previews/${productId}/preview_${manualPdf.originalname}`;
      await supabase.storage.from('previews').upload(finalPreviewPath, manualPdf.buffer, {
        contentType: 'application/pdf',
        upsert: true
      });
    } else {
      console.log('Generating automatic PDF preview via CloudConvert...');
      try {
        const sampleBuffer = await slicePptx(pptFile.buffer, 7);
        const job = await cloudConvert.jobs.create({
          "tasks": {
            "import-1": {
              "operation": "import/base64",
              "file": sampleBuffer.toString('base64'),
              "filename": "sample.pptx"
            },
            "task-1": {
              "operation": "convert",
              "input": ["import-1"],
              "output_format": "pdf"
            },
            "export-1": {
              "operation": "export/url",
              "input": ["task-1"],
              "inline": false,
              "archive_export": false
            }
          },
          "tag": `medslides-${productId}`
        });

        // Wait for job completion (polling)
        const finishedJob = await cloudConvert.jobs.wait(job.id);
        const exportTask = finishedJob.tasks.filter(t => t.operation === 'export/url' && t.status === 'finished')[0];
        
        if (exportTask && exportTask.result && exportTask.result.files) {
          const fileUrl = exportTask.result.files[0].url;
          const pdfRes = await fetch(fileUrl);
          const pdfBuffer = await pdfRes.arrayBuffer();
          
          finalPreviewPath = `previews/${productId}/preview_auto.pdf`;
          await supabase.storage.from('previews').upload(finalPreviewPath, Buffer.from(pdfBuffer), {
            contentType: 'application/pdf',
            upsert: true
          });
          console.log('Auto-PDF generation successful');
        } else {
          throw new Error('CloudConvert export task failed');
        }
      } catch (convErr) {
        console.error('PDF Conversion Error (Falling back to PPTX slice):', convErr);
        // Fallback: Just upload the sliced PPTX if conversion fails
        const sampleBuffer = await slicePptx(pptFile.buffer, 7);
        finalPreviewPath = `previews/${productId}/sample_${pptFile.originalname}`;
        await supabase.storage.from('previews').upload(finalPreviewPath, sampleBuffer, {
          contentType: pptFile.mimetype,
          upsert: true
        });
      }
    }

    // 3. Upload Thumbnail to 'previews' public bucket
    const thumbnailPath = `previews/${productId}/thumbnail.jpg`;
    const { error: thumbUploadError } = await supabase.storage
      .from('previews')
      .upload(thumbnailPath, thumbnailFile.buffer, {
        contentType: thumbnailFile.mimetype || 'image/jpeg',
        upsert: true
      });

    if (thumbUploadError) {
      console.error('Thumbnail Upload Error:', thumbUploadError);
      return res.status(500).json({ error: 'Failed to upload thumbnail image' });
    }

    // 4. Insert product row
    const { error: insertError } = await supabase
      .from('products')
      .insert([{
        id: productId,
        title,
        description: description || '',
        price: parseInt(price, 10),
        subject: subject || 'Uncategorized',
        total_slides: parseInt(total_slides, 10) || 0,
        level: level || 'UG',
        ppt_path: pptPath,
        preview_paths: [finalPreviewPath],
        thumbnail: thumbnailPath
      }]);

    if (insertError) {
      console.error('Product Insert Error:', insertError);
      return res.status(500).json({ error: 'Failed to record product in database' });
    }

    // 5. Return success
    console.log('Product upload and processing complete. ID:', productId);
    res.json({ success: true, productId });

  } catch (err) {
    console.error('Admin Upload Product Error:', err);
    res.status(500).json({ error: 'Internal server error while uploading' });
  }
});

// PATCH /api/admin/product/:id
router.patch('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, subject, total_slides, level } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined && price !== '') updateData.price = parseInt(price, 10);
    if (subject !== undefined) updateData.subject = subject;
    if (total_slides !== undefined && total_slides !== '') updateData.total_slides = parseInt(total_slides, 10);
    if (level !== undefined) updateData.level = level;

    const { data, error } = await supabase
      .from('products')
      .update(updateData)
      .eq('id', id)
      .select();

    if (error) {
      console.error('Update Product Error:', error);
      return res.status(500).json({ error: 'Failed to update product' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ success: true, product: data[0] });
  } catch (err) {
    console.error('Admin Update Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/product/:id
router.delete('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Get product row to find file paths
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('ppt_path, preview_paths, thumbnail')
      .eq('id', id)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // 2. Delete ppt from 'ppts' bucket
    if (product.ppt_path) {
      await supabase.storage.from('ppts').remove([product.ppt_path]);
    }

    // 3. Delete previews & thumbnail from 'previews' bucket
    const filesToDelete = [...(product.preview_paths || [])];
    if (product.thumbnail) filesToDelete.push(product.thumbnail);

    if (filesToDelete.length > 0) {
      const { error: previewDelErr } = await supabase.storage.from('previews').remove(filesToDelete);
      if (previewDelErr) console.error('Error deleting previews/thumbnail:', previewDelErr);
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
