const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase admin client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co', 
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Initialize Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder'
});

// POST /api/payment/create-order
router.post('/create-order', async (req, res) => {
  try {
    const { productId, userId } = req.body;
    if (!productId || !userId) {
      return res.status(400).json({ error: 'Missing productId or userId' });
    }

    // 1. Verify product exists in Supabase
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('price')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // 2. Check user hasn't already purchased
    const { data: existingPurchase, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('user_id', userId)
      .eq('product_id', productId)
      .maybeSingle();

    if (existingPurchase) {
      return res.status(400).json({ error: 'User has already purchased this product' });
    }

    // 3. Create Razorpay order
    const options = {
      amount: product.price, // Price is already configured in paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}_${productId.slice(0, 5)}`
    };

    const order = await razorpay.orders.create(options);

    // 4. Return order details
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error('Create Order Error:', err);
    res.status(500).json({ error: 'Internal server error while creating order' });
  }
});

// POST /api/payment/verify
router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, productId, userId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !productId || !userId) {
      return res.status(400).json({ error: 'Missing required payment verification fields' });
    }

    // 1. Verify HMAC SHA256 Signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder')
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Retrieve product amount to save in purchases table
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('price')
      .eq('id', productId)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: 'Product not found during verification' });
    }

    // 2. Insert into purchases table
    const { error: insertError } = await supabase
      .from('purchases')
      .insert([
        {
          user_id: userId,
          product_id: productId,
          razorpay_order_id,
          razorpay_payment_id,
          amount: product.price
        }
      ]);

    if (insertError) {
      console.error('Error inserting purchase:', insertError);
      return res.status(500).json({ error: 'Failed to record purchase' });
    }

    // 3. Return success
    res.json({ success: true });
  } catch (err) {
    console.error('Verify Payment Error:', err);
    res.status(500).json({ error: 'Internal server error during verification' });
  }
});

module.exports = router;
