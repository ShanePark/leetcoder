package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90011RotateTheEvenRacks {

    @Test
    public void test() {
        int[] racks = {1, 2, 3, 4, 5};
        rotateEvenRacks(racks);
        assertThat(racks).containsExactly(5, 2, 1, 4, 3);
        int[] racks2 = {7, 8};
        rotateEvenRacks(racks2);
        assertThat(racks2).containsExactly(7, 8);
        int[] racks3 = {4, 6, 9, 1};
        rotateEvenRacks(racks3);
        assertThat(racks3).containsExactly(9, 6, 4, 1);
    }

    public void rotateEvenRacks(int[] racks) {
        int carried = racks[0];
        for (int i = 2; i < racks.length; i += 2) {
            int next = racks[i];
            racks[i] = carried;
            carried = next;
        }
        racks[0] = carried;
    }

}
