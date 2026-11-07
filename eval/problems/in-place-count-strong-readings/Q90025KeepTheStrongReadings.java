package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90025KeepTheStrongReadings {

    @Test
    public void test() {
        int[] readings = {5, 2, 8, 1, 6};
        assertThat(keepStrong(readings, 5)).isEqualTo(3);
        assertThat(Arrays.copyOf(readings, 3)).containsExactly(5, 8, 6);

        int[] readings2 = {7, 7};
        assertThat(keepStrong(readings2, 10)).isEqualTo(0);

        int[] readings3 = {12, 3, 15};
        assertThat(keepStrong(readings3, 3)).isEqualTo(3);
        assertThat(Arrays.copyOf(readings3, 3)).containsExactly(12, 3, 15);
    }

    public int keepStrong(int[] readings, int floor) {
        int kept = 0;
        for (int reading : readings) {
            if (reading >= floor) {
                readings[kept++] = reading;
            }
        }
        return kept;
    }

}
