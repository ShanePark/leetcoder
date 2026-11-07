package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90019SpreadTheLanternOil {

    @Test
    public void test() {
        int[] filled = spreadOil(3, 8, 5);
        assertThat(filled).hasSize(3);
        assertThat(filled[0] + filled[1] + filled[2]).isEqualTo(8);
        assertThat(filled[0]).isBetween(1, 5);
        assertThat(filled[1]).isBetween(1, 5);
        assertThat(filled[2]).isBetween(1, 5);

        int[] filled2 = spreadOil(4, 7, 3);
        assertThat(filled2).hasSize(4);
        assertThat(filled2[0] + filled2[1] + filled2[2] + filled2[3]).isEqualTo(7);
        assertThat(filled2[0]).isBetween(1, 3);
        assertThat(filled2[1]).isBetween(1, 3);
        assertThat(filled2[2]).isBetween(1, 3);
        assertThat(filled2[3]).isBetween(1, 3);

        int[] filled3 = spreadOil(2, 6, 5);
        assertThat(filled3).hasSize(2);
        assertThat(filled3[0] + filled3[1]).isEqualTo(6);
        assertThat(filled3[0]).isBetween(1, 5);
        assertThat(filled3[1]).isBetween(1, 5);
    }

    public int[] spreadOil(int lamps, int oil, int cap) {
        int[] filled = new int[lamps];
        for (int lamp = 0; lamp < lamps; lamp++) {
            filled[lamp] = oil / lamps + (lamp < oil % lamps ? 1 : 0);
        }
        return filled;
    }

}
