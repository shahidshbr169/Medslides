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

// Advanced Promo Code Validation Helper
async function validatePromoInternal(code, userId, productIds) {
  if (!code) return { valid: false };
  const codeUpper = code.toUpperCase();
  
  if (codeUpper === 'WELCOME') {
    // Check if user has any prior purchases
    const { count, error } = await supabase
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    
    if (error) {
      console.error('Promo verification SQL error:', error);
      return { valid: false, message: 'Verification service error.' };
    }
    if (count > 0) return { valid: false, message: 'WELCOME is only available for your first purchase.' };
    return { valid: true, discountPercent: 0.10 };
  }

  if (codeUpper === 'BUNDLE') {
    const itemCount = productIds.length;
    if (itemCount >= 5) return { valid: true, discountPercent: 0.30 };
    if (itemCount >= 3) return { valid: true, discountPercent: 0.15 };
    return { valid: false, message: 'BUNDLE requires at least 3 items (15%) or 5 items (30%).' };
  }

  return { valid: false, message: 'Invalid promo code.' };
}

// POST /api/payment/validate-promo
router.post('/validate-promo', async (req, res) => {
  try {
    const { code, userId, productIds } = req.body;
    if (!code || !userId || !productIds) {
      return res.status(400).json({ valid: false, message: 'Missing validation data' });
    }
    
    const result = await validatePromoInternal(code, userId, productIds);
    res.json(result);
  } catch (err) {
    console.error('Promo validation error:', err);
    res.status(500).json({ valid: false, message: 'Internal error validating promo' });
  }
});

// POST /api/payment/create-order
router.post('/create-order', async (req, res) => {
  try {
    const { productId, productIds, userId, promoCode } = req.body;
    const items = productIds || (productId ? [productId] : []);

    if (items.length === 0 || !userId) {
      return res.status(400).json({ error: 'Missing productIds or userId' });
    }

    // 1. Verify all products exist in Supabase
    const { data: products, error: productError } = await supabase
      .from('products')
      .select('id, price')
      .in('id', items);

    if (productError || !products || products.length !== items.length) {
      return res.status(404).json({ error: 'One or more products not found' });
    }

    // 2. Check user hasn't already purchased any of them
    const { data: existingPurchases, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('user_id', userId)
      .in('product_id', items);

    if (existingPurchases && existingPurchases.length > 0) {
      return res.status(400).json({ error: 'User has already purchased one or more of these products' });
    }

    // Calculate total amount from DB prices
    let totalAmount = products.reduce((sum, p) => sum + p.price, 0);
    let discountAmount = 0;
    let appliedDiscountPercent = 0;

    // Apply Promo Code if provided
    if (promoCode) {
      const promoResult = await validatePromoInternal(promoCode, userId, items);
      if (promoResult.valid) {
        appliedDiscountPercent = promoResult.discountPercent;
        discountAmount = Math.floor(totalAmount * appliedDiscountPercent);
        totalAmount = totalAmount - discountAmount;
      }
    }

    // 3. Create Razorpay order
    const options = {
      amount: totalAmount, // Price is already in paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}_${userId.slice(0, 5)}`,
      notes: {
        promoCode: promoCode || 'NONE',
        originalAmount: totalAmount + discountAmount,
        discount: discountAmount,
        discountPercent: appliedDiscountPercent
      }
    };

    const order = await razorpay.orders.create(options);

    // 4. Return order details
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      discount: discountAmount,
      total: totalAmount
    });

  } catch (err) {
    console.error('Create Order Error:', err);
    res.status(500).json({ error: 'Internal server error while creating order' });
  }
});

// POST /api/payment/verify
router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, productId, productIds, userId } = req.body;
    const items = productIds || (productId ? [productId] : []);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || items.length === 0 || !userId) {
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

    // Retrieve product amounts to save in purchases table
    const { data: products, error: productError } = await supabase
      .from('products')
      .select('id, price')
      .in('id', items);

    if (productError || !products || products.length === 0) {
      return res.status(404).json({ error: 'Product not found during verification' });
    }

    // 2. Insert into purchases table formatting for multiple
    const insertData = products.map(p => ({
      user_id: userId,
      product_id: p.id,
      razorpay_order_id,
      razorpay_payment_id,
      amount: p.price
    }));

    const { error: insertError } = await supabase
      .from('purchases')
      .insert(insertData);

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
