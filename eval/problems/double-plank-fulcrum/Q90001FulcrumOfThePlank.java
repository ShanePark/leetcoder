package shane.leetcode.problems.easy;

import org.assertj.core.data.Offset;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90001FulcrumOfThePlank {

    @Test
    public void test() {
        assertThat(fulcrumPosition(new int[]{0, 4}, new int[]{3, 1})).isCloseTo(1.0, Offset.offset(0.00001));
        assertThat(fulcrumPosition(new int[]{1, 2, 6}, new int[]{2, 2, 1})).isCloseTo(2.4, Offset.offset(0.00001));
        assertThat(fulcrumPosition(new int[]{-2, 3, 7}, new int[]{1, 1, 2})).isCloseTo(3.75, Offset.offset(0.00001));
    }

    public double fulcrumPosition(int[] positions, int[] weights) {
        long weighted = 0;
        long total = 0;
        for (int i = 0; i < positions.length; i++) {
            weighted += (long) positions[i] * weights[i];
            total += weights[i];
        }
        return (double) weighted / total;
    }

}
