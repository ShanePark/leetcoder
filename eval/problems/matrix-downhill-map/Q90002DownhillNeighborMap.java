package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90002DownhillNeighborMap {

    @Test
    public void test() {
        assertThat(downhillMap(Ps.intArray("[[1,2],[3,4]]"))).isEqualTo(Ps.intArray("[[0,1],[1,2]]"));
        assertThat(downhillMap(Ps.intArray("[[5,5,5]]"))).isEqualTo(Ps.intArray("[[0,0,0]]"));
        assertThat(downhillMap(Ps.intArray("[[2,9,4],[7,1,6]]"))).isEqualTo(Ps.intArray("[[0,3,0],[2,0,2]]"));
    }

    private static final int[][] DIRECTIONS = {{0, 1}, {1, 0}, {0, -1}, {-1, 0}};

    public int[][] downhillMap(int[][] heights) {
        int rows = heights.length;
        int columns = heights[0].length;
        int[][] answer = new int[rows][columns];
        for (int row = 0; row < rows; row++) {
            for (int column = 0; column < columns; column++) {
                for (int[] direction : DIRECTIONS) {
                    int nextRow = row + direction[0];
                    int nextColumn = column + direction[1];
                    if (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < columns
                            && heights[nextRow][nextColumn] < heights[row][column]) {
                        answer[row][column]++;
                    }
                }
            }
        }
        return answer;
    }

}
