package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90020HullsAGapApart {

    @Test
    public void test() {
        int[] hulls = {14, 17, 11, 20};
        int[] pair = matchHulls(hulls, 3);
        assertThat(pair).hasSize(2);
        assertThat(pair[0]).isNotEqualTo(pair[1]);
        assertThat(Math.abs(hulls[pair[0]] - hulls[pair[1]])).isEqualTo(3);

        int[] hulls2 = {5, 2, 11, 8};
        int[] pair2 = matchHulls(hulls2, 6);
        assertThat(pair2).hasSize(2);
        assertThat(pair2[0]).isNotEqualTo(pair2[1]);
        assertThat(Math.abs(hulls2[pair2[0]] - hulls2[pair2[1]])).isEqualTo(6);

        int[] hulls3 = {7, 7, 12, 12};
        int[] pair3 = matchHulls(hulls3, 5);
        assertThat(pair3).hasSize(2);
        assertThat(pair3[0]).isNotEqualTo(pair3[1]);
        assertThat(Math.abs(hulls3[pair3[0]] - hulls3[pair3[1]])).isEqualTo(5);
    }

    public int[] matchHulls(int[] hulls, int gap) {
        for (int i = hulls.length - 1; i >= 0; i--) {
            for (int j = i - 1; j >= 0; j--) {
                if (Math.abs(hulls[i] - hulls[j]) == gap) {
                    return new int[] {i, j};
                }
            }
        }
        return new int[0];
    }

}
