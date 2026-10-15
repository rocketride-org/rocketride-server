import com.rocketride.tika_api.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class UtilTest {
    public static String createStringContainingNonPrintableCharacter() {
        // Build a string containing 0xFEFF, i.e. ZERO WIDTH NON-BREAKING SPACE
        String str = new String();
        str += "this";
        str += "\ufeff";
        str += "that";
        assertEquals(str.length(), 9);
        assertTrue(Util.hasNonPrintableCharacter(str));
        return str;
    }

    @Test
    void stripNonPrintableCharacters() {
        String str = createStringContainingNonPrintableCharacter();
        int length = str.length();
        str = Util.stripNonPrintableCharacters(str);
        assertEquals(str.length(), length - 1);

        String flower = "flower";
        String stripped = Util.stripNonPrintableCharacters(flower);
        assertEquals(flower, stripped);
    }
    
    @Test
    void filterNonPrintableCharacters() {
        String str = createStringContainingNonPrintableCharacter();
        char[] chars = str.toCharArray();
        Util.filterNonPrintableCharacters(chars, 0, chars.length);
        assertEquals(new String(chars), "this that");

        String flower = "flower";
        chars = flower.toCharArray();
        Util.filterNonPrintableCharacters(chars, 0, chars.length);
        assertEquals(new String(chars), flower);
    }
}