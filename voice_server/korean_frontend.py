"""Use prebuilt python-mecab-ko on Windows as well as Linux."""


def create_phonemizer():
    from g2pkk import G2p
    from mecab import MeCab

    class PortableG2p(G2p):
        def check_mecab(self):
            # Dependencies are installed explicitly during setup. Never invoke
            # g2pkk's implicit Windows `pip install eunjeon` / compiler path.
            pass

        def get_mecab(self):
            return MeCab()

    return PortableG2p()
