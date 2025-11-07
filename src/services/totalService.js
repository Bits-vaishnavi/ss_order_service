import { bankersRound } from '../utils/rounding.js';
import crypto from 'crypto';

/**
 * Calculate order totals with tax and shipping
 * @param {Array} pricedItems - Items with product_id, quantity, price
 * @param {Object} options - { taxRate, shippingCost }
 * @returns {Object} Totals breakdown
 */
export function calculateOrderTotals(pricedItems, options = {}) {
  const {
    taxRate = 0.05, // 5% default
    shippingCost = 0
  } = options;

  // 1. Calculate subtotal (sum of unit_price × qty)
  const subtotal = pricedItems.reduce(
    (sum, item) => sum + (item.price * item.quantity),
    0
  );
  
  // 2. Calculate tax (on subtotal)
  const taxAmount = subtotal * taxRate;
  
  // 3. Calculate final total
  const total = subtotal + taxAmount + shippingCost;
  
  // 4. Apply banker's rounding to all amounts
  return {
    subtotal: bankersRound(subtotal, 2),
    taxRate: taxRate,
    taxAmount: bankersRound(taxAmount, 2),
    shippingCost: bankersRound(shippingCost, 2),
    total: bankersRound(total, 2)
  };
}

/**
 * Generate totals signature (hash) to detect tampering
 * @param {Object} totals - Totals object from calculateOrderTotals
 * @param {Array} pricedItems - Items with prices
 * @returns {string} SHA-256 hash of totals
 */
export function generateTotalsSignature(totals, pricedItems) {
  // Create a deterministic string representation
  // Sort items by product_id for consistency
  const signatureData = {
    items: pricedItems
      .map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.price
      }))
      .sort((a, b) => a.product_id - b.product_id),
    subtotal: totals.subtotal,
    taxRate: totals.taxRate,
    taxAmount: totals.taxAmount,
    shippingCost: totals.shippingCost,
    total: totals.total
  };
  
  const signatureString = JSON.stringify(signatureData);
  return crypto.createHash('sha256').update(signatureString).digest('hex');
}

/**
 * Calculate shipping cost locally (no external service needed)
 * Simple calculation: base shipping + per-item cost
 * @param {Array} items - Order items with quantity
 * @returns {number} Shipping cost
 */
export function calculateShippingCost(items) {
  const baseShipping = 10.00; // Base shipping cost
  const perItemShipping = 2.00; // Per item shipping cost
  
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const shippingCost = baseShipping + (totalItems * perItemShipping);
  
  return bankersRound(shippingCost, 2);
}