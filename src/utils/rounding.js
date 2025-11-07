// ss_order_service-master/src/utils/rounding.js
/**
 * Banker's rounding (round half to even) to specified decimal places
 * @param {number} value - The value to round
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {number} Rounded value
 */
export function bankersRound(value, decimals = 2) {
    const factor = Math.pow(10, decimals);
    const num = value * factor;
    const rounded = Math.round(num);
    
    // Check if we're exactly at .5
    const remainder = Math.abs(num - rounded);
    if (remainder === 0.5) {
      // Round to nearest even number
      return (rounded % 2 === 0 ? rounded : rounded + (num > 0 ? 1 : -1)) / factor;
    }
    
    return rounded / factor;
  }