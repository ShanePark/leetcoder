package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90017DoublingCrateStaircase {

    @Test
    public void test() {
        assertThat(tallestStaircase(new ArrayList<>(List.of(5, 1, 2, 9)))).isEqualTo(3);
        assertThat(tallestStaircase(new ArrayList<>(List.of(4, 4, 4)))).isEqualTo(1);
        assertThat(tallestStaircase(new ArrayList<>(List.of(16, 3, 1, 8, 2)))).isEqualTo(4);
    }

    public int tallestStaircase(List<Integer> heights) {
        Collections.sort(heights);
        int count = 0;
        long minimum = 0;
        for (int height : heights) {
            if (height >= minimum) {
                count++;
                minimum = height * 2L;
            }
        }
        return count;
    }

}
