package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q90024TilingTheHeatMap {

    @Test
    public void test() {
        Tile tile = compressHeat(new int[][] {{6, 6}, {2, 6}});
        assertThat(tile.uniform).isFalse();
        assertThat(tile.heat).isEqualTo(6);
        assertThat(tile.nw.uniform).isTrue();
        assertThat(tile.nw.heat).isEqualTo(6);
        assertThat(tile.ne.uniform).isTrue();
        assertThat(tile.ne.heat).isEqualTo(6);
        assertThat(tile.sw.uniform).isTrue();
        assertThat(tile.sw.heat).isEqualTo(2);
        assertThat(tile.se.uniform).isTrue();
        assertThat(tile.se.heat).isEqualTo(6);
        assertThat(tile.nw.nw).isNull();

        Tile tile2 = compressHeat(new int[][] {{3, 3, 5, 5}, {3, 3, 5, 5}, {3, 3, 5, 7}, {3, 3, 5, 5}});
        assertThat(tile2.uniform).isFalse();
        assertThat(tile2.heat).isEqualTo(7);
        assertThat(tile2.nw.uniform).isTrue();
        assertThat(tile2.nw.heat).isEqualTo(3);
        assertThat(tile2.ne.uniform).isTrue();
        assertThat(tile2.ne.heat).isEqualTo(5);
        assertThat(tile2.sw.uniform).isTrue();
        assertThat(tile2.sw.heat).isEqualTo(3);
        assertThat(tile2.se.uniform).isFalse();
        assertThat(tile2.se.heat).isEqualTo(7);
        assertThat(tile2.se.nw.uniform).isTrue();
        assertThat(tile2.se.nw.heat).isEqualTo(5);
        assertThat(tile2.se.ne.uniform).isTrue();
        assertThat(tile2.se.ne.heat).isEqualTo(7);
        assertThat(tile2.se.sw.uniform).isTrue();
        assertThat(tile2.se.sw.heat).isEqualTo(5);
        assertThat(tile2.se.se.uniform).isTrue();
        assertThat(tile2.se.se.heat).isEqualTo(5);

        Tile tile3 = compressHeat(new int[][] {{8}});
        assertThat(tile3.uniform).isTrue();
        assertThat(tile3.heat).isEqualTo(8);
        assertThat(tile3.nw).isNull();
    }

    public Tile compressHeat(int[][] grid) {
        return tileOf(grid, 0, 0, grid.length);
    }

    private Tile tileOf(int[][] grid, int top, int left, int side) {
        if (side == 1) {
            return new Tile(true, grid[top][left]);
        }
        int half = side / 2;
        Tile nw = tileOf(grid, top, left, half);
        Tile ne = tileOf(grid, top, left + half, half);
        Tile sw = tileOf(grid, top + half, left, half);
        Tile se = tileOf(grid, top + half, left + half, half);
        boolean same = nw.uniform && ne.uniform && sw.uniform && se.uniform
                && nw.heat == ne.heat && ne.heat == sw.heat && sw.heat == se.heat;
        if (same) {
            return new Tile(true, nw.heat);
        }
        Tile tile = new Tile(false, Math.max(Math.max(nw.heat, ne.heat), Math.max(sw.heat, se.heat)));
        tile.nw = nw;
        tile.ne = ne;
        tile.sw = sw;
        tile.se = se;
        return tile;
    }

    class Tile {
        public boolean uniform;
        public int heat;
        public Tile nw;
        public Tile ne;
        public Tile sw;
        public Tile se;

        public Tile(boolean uniform, int heat) {
            this.uniform = uniform;
            this.heat = heat;
        }
    }

}
