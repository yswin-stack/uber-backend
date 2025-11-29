/**
 * Expire Holds Job
 * 
 * Runs periodically to expire holds that have passed their 5-minute window.
 * Should be called by a scheduler (e.g., every minute).
 */

import { expireHolds, getHoldStats } from '../scheduler';

/**
 * Run the hold expiration job
 */
export async function runExpireHoldsJob(): Promise<{
  expiredCount: number;
  stats: {
    activeHolds: number;
    confirmedToday: number;
    expiredToday: number;
    cancelledToday: number;
  };
}> {
  console.log('[ExpireHoldsJob] Starting...');
  
  try {
    // Expire holds
    const expiredCount = await expireHolds();
    
    if (expiredCount > 0) {
      console.log(`[ExpireHoldsJob] Expired ${expiredCount} hold(s)`);
    }
    
    // Get stats for monitoring
    const stats = await getHoldStats();
    
    console.log('[ExpireHoldsJob] Complete', {
      expiredCount,
      activeHolds: stats.activeHolds,
    });
    
    return { expiredCount, stats };
  } catch (err) {
    console.error('[ExpireHoldsJob] Error:', err);
    throw err;
  }
}

// If run directly (e.g., via cron)
if (require.main === module) {
  runExpireHoldsJob()
    .then(result => {
      console.log('Job completed:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Job failed:', err);
      process.exit(1);
    });
}

