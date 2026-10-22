import { Image } from "react-native";
import { miniatura } from "../core/utils";

function Miniatura({ url, size }) {
    return (
        <Image 
            source={miniatura(url)}  
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: '#e0e0e0', 
            }}
        />
    );
}

export default Miniatura;




