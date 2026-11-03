package shane.leetcode.problems.easy;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90005PanelsClearOfTheChimneyShadow {

    @Test
    public void test() {
        assertThat(countClearPanels(Ps.charArray("[[\"S\",\"C\"],[\".\",\"S\"]]"))).isEqualTo(1);
        assertThat(countClearPanels(Ps.charArray("[[\"C\",\"S\",\".\"],[\"S\",\"S\",\"C\"],[\"S\",\".\",\"S\"]]"))).isEqualTo(2);
        assertThat(countClearPanels(Ps.charArray("[[\"S\"],[\"S\"]]"))).isEqualTo(2);
    }

    public int countClearPanels(char[][] roof) {
        int count = 0;
        for (int column = 0; column < roof[0].length; column++) {
            for (int row = 0; row < roof.length && roof[row][column] != 'C'; row++) {
                if (roof[row][column] == 'S') {
                    count++;
                }
            }
        }
        return count;
    }

}
