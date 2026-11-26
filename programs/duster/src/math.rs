//! Arytmetyka stakingu. Czyste funkcje bez dostepu do kont, zeby dalo sie je
//! testowac zwyklym `cargo test`.
//!
//! Model: pula udzialow. Kazdy stakujacy ma udzialy, a wartosc udzialu rosnie,
//! gdy do puli trafia odkupiony DUSTER. Nagroda z buybacku nie jest dopisywana
//! od razu, tylko uwalnia sie liniowo przez kolejna godzine. Dzieki temu nie
//! oplaca sie wchodzic do puli na chwile przed buybackiem i wychodzic zaraz po.

/// Czesc ostatnich nagrod, ktora w chwili `now` jest jeszcze nieuwolniona.
pub fn unreleased_at(unreleased: u64, updated: i64, end: i64, now: i64) -> u64 {
    if now >= end || end <= updated {
        return 0;
    }
    if now <= updated {
        return unreleased;
    }
    let remaining = (end - now) as u128;
    let total = (end - updated) as u128;
    // Zaokraglenie w gore: pula nigdy nie pokazuje wiecej, niz faktycznie uwolniono.
    let value = (unreleased as u128 * remaining).div_ceil(total);
    value.min(unreleased as u128) as u64
}

/// Aktywa nalezace juz do stakujacych (bez czesci jeszcze nieuwolnionej).
pub fn effective_assets(total_assets: u64, unreleased_now: u64) -> u64 {
    total_assets.saturating_sub(unreleased_now)
}

/// Ile udzialow dostaje wplata `amount`. Zaokraglenie w dol, na korzysc puli.
pub fn shares_for_deposit(amount: u64, total_shares: u64, effective: u64) -> Option<u64> {
    if total_shares == 0 || effective == 0 {
        // Pusta pula: udzialy 1:1. Ewentualne resztki w puli przypadaja pierwszemu stakujacemu.
        return Some(amount);
    }
    let shares = (amount as u128).checked_mul(total_shares as u128)? / effective as u128;
    u64::try_from(shares).ok()
}

/// Ile tokenow przypada na `shares` udzialow. Zaokraglenie w dol, na korzysc puli.
pub fn assets_for_shares(shares: u64, total_shares: u64, effective: u64) -> Option<u64> {
    if total_shares == 0 || shares > total_shares {
        return None;
    }
    let assets = (shares as u128).checked_mul(effective as u128)? / total_shares as u128;
    u64::try_from(assets).ok()
}

/// `amount * bps / 10_000`, zaokraglone w dol.
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / 10_000) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUSTER: u64 = 1_000_000; // 6 miejsc po przecinku

    #[test]
    fn stream_releases_linearly() {
        assert_eq!(unreleased_at(3_600, 0, 3_600, 0), 3_600);
        assert_eq!(unreleased_at(3_600, 0, 3_600, 900), 2_700);
        assert_eq!(unreleased_at(3_600, 0, 3_600, 1_800), 1_800);
        assert_eq!(unreleased_at(3_600, 0, 3_600, 3_600), 0);
        assert_eq!(unreleased_at(3_600, 0, 3_600, 99_999), 0);
        // Zegar cofniety wzgledem zapisu: nic nie jest uwolnione.
        assert_eq!(unreleased_at(3_600, 100, 3_700, 50), 3_600);
        // Zdegenerowany strumien nie dzieli przez zero.
        assert_eq!(unreleased_at(3_600, 100, 100, 100), 0);
    }

    #[test]
    fn stream_never_exceeds_original_and_rounds_up() {
        assert_eq!(unreleased_at(10, 0, 3, 1), 7); // 6,67 -> 7
        assert_eq!(unreleased_at(u64::MAX, 0, 3_600, 1), u64::MAX - u64::MAX / 3_600);
    }

    #[test]
    fn first_deposit_is_one_to_one() {
        assert_eq!(shares_for_deposit(5 * DUSTER, 0, 0), Some(5 * DUSTER));
        // Resztki w pustej puli nie zmieniaja kursu pierwszej wplaty.
        assert_eq!(shares_for_deposit(5 * DUSTER, 0, 123), Some(5 * DUSTER));
    }

    #[test]
    fn rewards_raise_share_value_without_new_shares() {
        // Dwoch stakujacych po 1000, potem 200 nagrody w pelni uwolnione.
        let total_shares = 2_000 * DUSTER;
        let effective = 2_200 * DUSTER;
        assert_eq!(assets_for_shares(1_000 * DUSTER, total_shares, effective), Some(1_100 * DUSTER));
        // Nowa wplata 1100 dostaje 1000 udzialow, czyli nie rozwadnia poprzednikow.
        assert_eq!(shares_for_deposit(1_100 * DUSTER, total_shares, effective), Some(1_000 * DUSTER));
    }

    #[test]
    fn hopping_in_before_buyback_earns_only_released_part() {
        // Pula 1000, stakujacy A ma wszystko. Buyback dodaje 100 w chwili t=0.
        let (mut shares, mut assets) = (1_000 * DUSTER, 1_000 * DUSTER);
        assets += 100 * DUSTER;
        let (unreleased, updated, end) = (100 * DUSTER, 0, 3_600);

        // B wchodzi sekunde po buybacku z 1000 i wychodzi po 60 sekundach.
        let eff_in = effective_assets(assets, unreleased_at(unreleased, updated, end, 1));
        let b_shares = shares_for_deposit(1_000 * DUSTER, shares, eff_in).unwrap();
        shares += b_shares;
        assets += 1_000 * DUSTER;

        let eff_out = effective_assets(assets, unreleased_at(unreleased, updated, end, 61));
        let b_out = assets_for_shares(b_shares, shares, eff_out).unwrap();
        let profit = b_out - 1_000 * DUSTER;
        // Za minute dostaje ok. polowy z 1/60 nagrody, a nie polowe calej.
        assert!(profit < DUSTER, "zysk {profit}");
        assert!(profit > DUSTER / 2, "zysk {profit}");
    }

    #[test]
    fn rounding_never_pays_out_more_than_pool_holds() {
        let total_shares = 3u64;
        let effective = 10u64;
        let a = assets_for_shares(1, total_shares, effective).unwrap();
        let b = assets_for_shares(1, total_shares, effective).unwrap();
        let c = assets_for_shares(1, total_shares, effective).unwrap();
        assert!(a + b + c <= effective);
        // Wplata i natychmiastowa wyplata nie daje zysku.
        let s = shares_for_deposit(7, total_shares, effective).unwrap();
        let back = assets_for_shares(s, total_shares + s, effective + 7).unwrap();
        assert!(back <= 7);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        assert_eq!(assets_for_shares(1, 0, 10), None);
        assert_eq!(assets_for_shares(5, 4, 10), None);
        assert_eq!(shares_for_deposit(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn bps() {
        assert_eq!(bps_of(1_000_000, 500), 50_000);
        assert_eq!(bps_of(u64::MAX, 10_000), u64::MAX);
        assert_eq!(bps_of(19, 5_000), 9);
    }
}
