// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
use vdoninja_core::turn::{select_turn_servers, TurnList};

#[test]
fn scalar_and_array_turn_urls() {
    for urls in [r#""turn:custom.test:3478""#, r#"["turn:custom.test:3478"]"#] {
        let input = format!(
            r#"{{"servers":[{{"urls":{urls},"username":"user","credential":"secret","udp":true}}]}}"#
        );
        let list: TurnList = serde_json::from_str(&input).unwrap();
        let selected = select_turn_servers(&list.servers, 0, false);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].urls, ["turn:custom.test:3478"]);
        assert_eq!(selected[0].username, "user");
        assert_eq!(selected[0].credential, "secret");
    }
}
