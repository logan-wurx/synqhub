//! Screen sync's sending side for a Govee lamp: the segment pages worth resending (only those whose colours moved
//! enough) and their frames (the same `33 05 15 04` pages the frontend sends, so the guard passes them). The pace is
//! the sampler's (screen.rs `FAST` / `SLOW`).

use super::guard::{frame, FRAME_LEN};

/// A segment colour that moved less than this on every channel isn't resent.
pub const THRESHOLD: u8 = 8;

const PAGE: usize = 4;

/// The pages (1-based) holding a segment that moved by more than `THRESHOLD` (every page when nothing was sent yet).
/// `next` has one colour per segment of the light.
pub fn changed_pages(sent: &[[u8; 3]], next: &[[u8; 3]]) -> Vec<u8> {
    let pages = next.len().div_ceil(PAGE);
    (0..pages)
        .filter(|&p| {
            (p * PAGE..((p + 1) * PAGE).min(next.len())).any(|i| match sent.get(i) {
                None => true,
                Some(s) => (0..3).any(|k| s[k].abs_diff(next[i][k]) > THRESHOLD),
            })
        })
        .map(|p| p as u8 + 1)
        .collect()
}

/// A segment page: `33 05 15 04 page RGB×4`, `colours` being one per segment (a slot past the last segment is zero).
pub fn page_frame(page: u8, colours: &[[u8; 3]]) -> [u8; FRAME_LEN] {
    let mut b = vec![0x33, 0x05, 0x15, 0x04, page];
    for i in 0..PAGE {
        b.extend_from_slice(colours.get((page as usize - 1) * PAGE + i).unwrap_or(&[0; 3]));
    }
    frame(&b)
}

/// Gradual change off, sent once when sync starts (as the app does before segment pages).
pub fn gradual_off() -> [u8; FRAME_LEN] {
    frame(&[0x33, 0xa3, 0x00])
}

#[cfg(test)]
mod tests {
    use super::super::guard::{check_frame, model};
    use super::*;

    #[test]
    fn only_moved_pages_are_resent_and_every_frame_passes_the_guard() {
        let a = vec![[10u8, 20, 30]; 14];
        assert_eq!(changed_pages(&[], &a), vec![1, 2, 3, 4], "everything at first");
        assert_eq!(changed_pages(&a, &a), Vec::<u8>::new(), "nothing moved: nothing sent");
        let mut b = a.clone();
        b[5] = [10, 20, 30 + THRESHOLD];
        assert_eq!(changed_pages(&a, &b), Vec::<u8>::new(), "a wobble within the threshold");
        b[5] = [10, 20, 31 + THRESHOLD];
        b[13] = [200, 0, 0];
        assert_eq!(changed_pages(&a, &b), vec![2, 4]);
        let h6076 = model("H6076").unwrap();
        for p in 1..=4 {
            assert!(check_frame(h6076, &page_frame(p, &b)).is_ok(), "page {p}");
        }
        assert!(check_frame(h6076, &gradual_off()).is_ok());
        // Five segments (the H1A42): two pages, the second with one colour.
        let five = vec![[1u8, 2, 3]; 5];
        assert_eq!(changed_pages(&[], &five), vec![1, 2]);
        assert!(check_frame(model("H1A42").unwrap(), &page_frame(2, &five)).is_ok());
        // The last page carries segments 13 and 14 only.
        assert_eq!(&page_frame(4, &b)[5..17], &[10, 20, 30, 200, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
}
