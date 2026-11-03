package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90013LocateTheLoneDeposit {

    @Test
    public void test() {
        assertThat(locateDeposit(new ArrayLedger(0, 0, 7, 0))).isEqualTo(2);
        assertThat(locateDeposit(new ArrayLedger(5))).isEqualTo(0);
        assertThat(locateDeposit(new ArrayLedger(0, 3, 0, 0, 0, 0))).isEqualTo(1);
    }

    public int locateDeposit(SealedLedger ledger) {
        int left = 0;
        int right = ledger.size() - 1;
        while (left < right) {
            int middle = left + (right - left) / 2;
            if (ledger.rangeSum(left, middle) > 0) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        return left;
    }

    interface SealedLedger {
        int size();

        long rangeSum(int from, int to);
    }

    /** Stands in for the judge's implementation, so this file can run on its own. */
    static class ArrayLedger implements SealedLedger {
        private final int[] entries;

        ArrayLedger(int... entries) {
            this.entries = entries;
        }

        @Override
        public int size() {
            return entries.length;
        }

        @Override
        public long rangeSum(int from, int to) {
            long sum = 0;
            for (int i = from; i <= to; i++) {
                sum += entries[i];
            }
            return sum;
        }
    }

}
